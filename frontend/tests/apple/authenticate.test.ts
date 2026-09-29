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
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

// The real signer spawns a Worker and runs an emulator, neither of which exist
// here; what it produces is not what these tests are about.
vi.mock("../../src/apple/sap/client", () => ({
  prepareSigner: vi.fn().mockResolvedValue(undefined),
  signWithSap: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
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

  it("gives up after three transient statuses and names them", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchBag).mockResolvedValue({
        authURL:
          "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
      });
      vi.mocked(appleRequest)
        .mockResolvedValueOnce(reply(204, ""))
        .mockResolvedValueOnce(reply(503, ""))
        .mockResolvedValueOnce(reply(404, ""));

      const pending = authenticate(
        "test@example.com",
        "password",
        undefined,
        undefined,
        "aabbccddeeff",
      ).catch((error: Error) => error);

      await vi.advanceTimersByTimeAsync(30_000);
      const error = (await pending) as Error;

      expect(error.message).toContain("204, 503, 404");
      expect(vi.mocked(appleRequest)).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
