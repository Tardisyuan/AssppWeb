import type { Account, Cookie } from "../types";
import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, defaultAuthURL } from "./bag";
import { prepareSigner } from "./sap/client";
import i18n from "../i18n";

// Apple returns these on the auth endpoint at random. ipatool retries the same
// set: three attempts, ten seconds apart.
const TRANSIENT_STATUSES = new Set([204, 404, 429]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

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

  const defaultAuthEndpoint = new URL(defaultAuthURL);
  defaultAuthEndpoint.searchParams.set("guid", deviceId);
  let requestHost = defaultAuthEndpoint.hostname;
  let requestPath = `${defaultAuthEndpoint.pathname}${defaultAuthEndpoint.search}`;

  const bag = await fetchBag(deviceId);
  const authEndpoint = new URL(bag.authURL);
  authEndpoint.searchParams.set("guid", deviceId);
  requestHost = authEndpoint.hostname;
  requestPath = `${authEndpoint.pathname}${authEndpoint.search}`;

  // When the bag advertises the SAP signing protocol, every request to the
  // auth endpoint must carry X-Apple-ActionSignature over its body bytes.
  // The signer sees only the hardware ID and public Apple assets — never the
  // password — because signing happens here in the browser. It is kept as a
  // singleton between attempts (2FA retries reuse the same session).
  let sapSigner = null as Awaited<ReturnType<typeof prepareSigner>> | null;
  if (bag.sapEndpoints) {
    sapSigner = await prepareSigner(deviceId, bag.sapEndpoints);
  }

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

  if (sapSigner) {
    // The signature must cover the exact bytes on the wire; libcurl sends the
    // body string as UTF-8, so sign its encoded form. Signed once: the body is
    // identical across retries and redirects, and signing costs seconds.
    headers["X-Apple-ActionSignature"] = await sapSigner.sign(
      new TextEncoder().encode(plistBody),
    );
  }

  let currentAttempt = 0;
  let redirectAttempt = 0;
  const transientStatuses: number[] = [];

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
      if (TRANSIENT_STATUSES.has(response.status) || response.status >= 500) {
        transientStatuses.push(response.status);

        if (currentAttempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }

        throw new Error(
          i18n.t("errors.auth.transient", {
            statuses: transientStatuses.join(", "),
          }),
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
