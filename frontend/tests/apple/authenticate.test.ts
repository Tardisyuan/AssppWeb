import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { authenticate } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  // The real value: the native endpoint, which is a rotation target distinct
  // from the legacy one the live bag advertises.
  defaultAuthURL: "https://auth.itunes.apple.com/auth/v1/native/fast/",
}));

// The real setup exchange talks to Apple over two round-trips. These tests
// are about what authenticate() does with the auth response, so the session
// is stubbed; tests/apple/sap.test.ts covers the signer itself.
vi.mock("../../src/apple/sap", () => ({
  connectSAP: vi
    .fn()
    .mockResolvedValue({ sign: async () => new Uint8Array([1, 2, 3]) }),
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("aabbccddeeff");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });

  it("keeps the previous storefront and pod when the response omits them", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    // A renewal that succeeds without repeating the storefront or pod headers.
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: { firstName: "Test", lastName: "User" },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    const renewed = await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
      { store: "143460", pod: "18" },
    );

    // Blanking either one hides the account from every region filter, or sends
    // later calls to the default pod.
    expect(renewed.store).toBe("143460");
    expect(renewed.pod).toBe("18");
  });

  it("prefers the storefront and pod the response does send", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: { "x-set-apple-store-front": "143441-1,29", pod: "25" },
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: { firstName: "Test", lastName: "User" },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    const renewed = await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
      { store: "143460", pod: "18" },
    );

    expect(renewed.store).toBe("143441");
    expect(renewed.pod).toBe("25");
  });

  function okBody() {
    return buildPlist({
      accountInfo: {
        appleId: "test@example.com",
        address: { firstName: "Test", lastName: "User" },
      },
      passwordToken: "token",
      dsPersonId: "123",
    });
  }

  function reply(status: number, body: string, headers: Record<string, string> = {}) {
    return { status, statusText: "", headers, rawHeaders: [], body };
  }

  // Apple answers this endpoint with 204, 404, 429 or a 5xx at random, so a
  // single bad status must not end the attempt.
  it("retries a transient status and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      vi.mocked(appleRequest)
        .mockResolvedValueOnce(reply(204, ""))
        .mockResolvedValueOnce(reply(200, okBody()));

      const pending = authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      );

      await vi.advanceTimersByTimeAsync(10_000);
      const account = await pending;

      expect(account.passwordToken).toBe("token");
      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Apple sheds load per route, so each retry is a fresh draw only if it goes
  // somewhere else.
  it("rotates endpoints across retries instead of replaying one", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      vi.mocked(appleRequest).mockResolvedValue(reply(204, ""));

      const pending = authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      ).catch((error: Error) => error);

      await vi.advanceTimersByTimeAsync(60_000);
      await pending;

      const targets = vi
        .mocked(appleRequest)
        .mock.calls.map((call) => `${call[0].host}${call[0].path}`);

      // The bag endpoint and the legacy endpoint are the same URL here, so
      // two distinct candidates remain and the eight attempts alternate.
      expect(new Set(targets)).toEqual(
        new Set([
          "buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=aabbccddeeff",
          "auth.itunes.apple.com/auth/v1/native/fast/?guid=aabbccddeeff",
        ]),
      );
      expect(targets[0]).toContain("buy.itunes.apple.com");
      expect(targets[1]).toContain("auth.itunes.apple.com");
      expect(targets[2]).toContain("buy.itunes.apple.com");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the retry budget and names the statuses", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      const statuses = [204, 503, 404, 204, 429, 500, 404, 503];
      for (const status of statuses) {
        vi.mocked(appleRequest).mockResolvedValueOnce(reply(status, ""));
      }

      const pending = authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      ).catch((error: Error) => error);

      await vi.advanceTimersByTimeAsync(60_000);
      const error = (await pending) as Error;

      expect(error.message).toContain(statuses.join(", "));
      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(statuses.length);
    } finally {
      vi.useRealTimers();
    }
  });

  // An edge refusal and a service answering badly need different advice: the
  // edge sheds load at random, a service answer means Apple read the request.
  it("reports an edge refusal when no Apple service stamped the response", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      vi.mocked(appleRequest).mockResolvedValue(
        reply(404, "", { "content-type": "text/html", "content-length": "146" }),
      );

      const pending = authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      ).catch((error: Error) => error);

      await vi.advanceTimersByTimeAsync(60_000);
      const error = (await pending) as Error;

      expect(error.message).toContain("before reaching the sign-in service");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports Apple trouble when a service did stamp the response", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      vi.mocked(appleRequest).mockResolvedValue(
        reply(503, "", { "apple-originating-system": "MZFinance" }),
      );

      const pending = authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      ).catch((error: Error) => error);

      await vi.advanceTimersByTimeAsync(60_000);
      const error = (await pending) as Error;

      expect(error.message).toContain("kept answering");
    } finally {
      vi.useRealTimers();
    }
  });
});
