import type { Account, Cookie } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, defaultAuthURL } from "./bag";
import { connectSAP } from "./sap";
import { toBase64 } from "./sap/bytes";
import type { SAPSigner } from "./sap/signer";
import i18n from "../i18n";

// Apple's edge load-sheds this route: identical requests measured from a clean
// network come back 204/301/403/404/500/503 at random, and only ~40% of them
// carry the x-responding-instance header that proves MZFinance itself answered.
// So the retry budget has to outlast the noise — eight tries miss the service
// about 2% of the time, three missed it 20% of the time. The junk comes back in
// milliseconds, so a short delay is enough.
const TRANSIENT_STATUSES = new Set([204, 404, 429]);
const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 2_000;

// The legacy endpoint, which is what the live bag advertises anyway. Kept as
// its own constant because it is also a rotation target when the bag points
// somewhere else.
const LEGACY_AUTH_URL =
  "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate";

interface AuthEndpoint {
  host: string;
  path: string;
}

// The shedding is per route, so a retry goes to the next endpoint rather than
// back to the one that just refused. Each is a separate draw. ipatool#513
// reports the legacy endpoint answering 302 to a pod host where the reposted
// body returns 200, which the redirect handling below already follows.
//
// Every candidate is in Apple's SAP-signed list and takes the same body, so
// one signature covers all of them.
function authEndpoints(bagURL: string, deviceId: string): AuthEndpoint[] {
  const endpoints: AuthEndpoint[] = [];
  const seen = new Set<string>();

  for (const candidate of [bagURL, LEGACY_AUTH_URL, defaultAuthURL]) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    url.searchParams.set("guid", deviceId);
    const key = url.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    endpoints.push({
      host: url.hostname,
      path: `${url.pathname}${url.search}`,
    });
  }

  return endpoints;
}

// One SAP session per page session. Setup costs two round-trips to Apple and
// a session signs any number of bodies, so sign-in attempts and the
// verification-code step that follows reuse it. A failed setup is not cached.
let sapSession: Promise<SAPSigner> | null = null;

function sapSigner(): Promise<SAPSigner> {
  sapSession ??= connectSAP().catch((error: unknown) => {
    sapSession = null;
    throw error;
  });
  return sapSession;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
  // Apple only sends the storefront and pod headers on some responses, and the
  // account returned here replaces the stored one wholesale. Without the
  // previous values to fall back on, a renewal that omits them blanks
  // account.store — which every region filter reads, so the account vanishes
  // from the app — and drops the pod, sending later calls to the wrong host.
  previous?: Pick<Account, "store" | "pod">,
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = "";
  let lastError: Error | null = null;

  const bag = await fetchBag(deviceId);
  const endpoints = authEndpoints(bag.authURL, deviceId);
  let endpointIndex = 0;
  let requestHost = endpoints[0].host;
  let requestPath = endpoints[0].path;

  // Apple requires X-Apple-ActionSignature over the body bytes of every
  // request to the auth endpoint. The session is established here in the
  // browser, so the password reaches the signer only as the opaque bytes it
  // signs. The handshake carries no credentials at all. An unsigned request
  // is answered 403, so there is no fallback worth keeping: a setup failure
  // fails the sign-in.
  const signer = await sapSigner();

  const plistBody = buildPlist({
    appleId: email,
    attempt: code ? "2" : "4",
    guid: deviceId,
    password: code ? `${password}${code}` : password,
    rmp: "0",
    why: "signIn",
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-apple-plist",
  };

  // The signature must cover the exact bytes on the wire; libcurl sends the
  // body string as UTF-8, so sign its encoded form. Signed once: the body is
  // identical across retries and redirects, and each signature consumes IV
  // state from the session.
  headers["X-Apple-ActionSignature"] = toBase64(
    await signer.sign(new TextEncoder().encode(plistBody)),
  );

  let currentAttempt = 0;
  let redirectAttempt = 0;
  const transientStatuses: number[] = [];
  // Apple's own services stamp these. Their absence means the response came
  // from the edge, so the request never reached the service that checks
  // credentials — a different problem from a service that answered badly.
  let reachedAppleService = false;

  while (currentAttempt < MAX_ATTEMPTS && redirectAttempt <= 3) {
    currentAttempt++;

    try {
      const response = await appleRequest({
        method: "POST",
        host: requestHost,
        path: requestPath,
        headers,
        body: plistBody,
        cookies,
      });

      cookies = extractAndMergeCookies(response.rawHeaders, cookies);

      // Read store front
      const storeHeader = response.headers["x-set-apple-store-front"];
      if (storeHeader) {
        const parts = storeHeader.split("-");
        if (parts[0]) {
          storeFront = parts[0];
        }
      }

      // Read pod
      const podHeader = response.headers["pod"];
      const pod = podHeader || undefined;

      // Handle redirect. The native /fast auth host can answer with 301 as
      // well as the usual 302, so follow the full set of redirect statuses.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (!location) {
          throw new Error(i18n.t("errors.auth.redirectLocation"));
        }
        const url = new URL(location);
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        currentAttempt--;
        redirectAttempt++;
        continue;
      }

      // Apple answers this endpoint with 204, 404, 429 or a 5xx at random,
      // regardless of the request — the same body a moment later succeeds. So
      // these are retried rather than reported, matching what ipatool settled
      // on after the same trouble (their issue #530).
      if (
        response.headers["apple-originating-system"] ||
        response.headers["x-apple-jingle-correlation-key"] ||
        response.headers["x-responding-instance"]
      ) {
        reachedAppleService = true;
      }

      if (TRANSIENT_STATUSES.has(response.status) || response.status >= 500) {
        transientStatuses.push(response.status);

        // A 204 carries no body and no failure code, so the response headers
        // are the only evidence of which Apple service answered and whether
        // the request reached the credential check at all. They travel inside
        // the wisp tunnel, so they cannot be read from devtools.
        console.warn(
          `[Auth] HTTP ${response.status} from ${requestHost}${requestPath}`,
          Object.fromEntries(
            [
              "apple-originating-system",
              "x-responding-instance",
              "x-apple-jingle-correlation-key",
              "x-apple-request-uuid",
              "apple-timing-app",
              "apple-seq",
              "apple-tk",
              "content-type",
              "content-length",
              "location",
              "pod",
              "x-set-apple-store-front",
              "retry-after",
              "www-authenticate",
            ]
              .map((name) => [name, response.headers[name]])
              .filter(([, value]) => value !== undefined),
          ),
          { signatureChars: headers["X-Apple-ActionSignature"].length },
        );

        if (currentAttempt < MAX_ATTEMPTS) {
          endpointIndex = (endpointIndex + 1) % endpoints.length;
          requestHost = endpoints[endpointIndex].host;
          requestPath = endpoints[endpointIndex].path;
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }

        throw new Error(
          i18n.t(
            reachedAppleService
              ? "errors.auth.transient"
              : "errors.auth.edgeRefused",
            { statuses: transientStatuses.join(", ") },
          ),
        );
      }

      // Handle non-plist responses (e.g. 403 with empty body)
      if (!response.body.trim()) {
        throw new Error(
          i18n.t("errors.auth.emptyBody", { status: response.status }),
        );
      }

      const dict = parsePlist(response.body) as Record<string, any>;

      // Check for 2FA requirement
      if (
        dict.failureType === "" &&
        !code &&
        dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
      ) {
        throw new AuthenticationError(
          i18n.t("errors.auth.requiresVerification"),
          true,
        );
      }

      const failureMessage =
        (dict.dialog as Record<string, any>)?.explanation ??
        dict.customerMessage;

      const accountInfo = dict.accountInfo as Record<string, any>;
      if (!accountInfo) {
        throw new Error(
          failureMessage ?? i18n.t("errors.auth.missingAccountInfo"),
        );
      }

      const address = accountInfo.address as Record<string, any>;
      if (!address) {
        throw new Error(failureMessage ?? i18n.t("errors.auth.missingAddress"));
      }

      const account: Account = {
        email,
        password,
        appleId: (accountInfo.appleId as string) ?? "",
        store: storeFront || previous?.store || "",
        firstName: (address.firstName as string) ?? "",
        lastName: (address.lastName as string) ?? "",
        passwordToken: (dict.passwordToken as string) ?? "",
        directoryServicesIdentifier: String(dict.dsPersonId ?? ""),
        cookies,
        deviceIdentifier: deviceId,
        pod: pod ?? previous?.pod,
      };

      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) {
        throw e;
      }
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastError ?? new Error(i18n.t("errors.auth.unknownReason"));
}
