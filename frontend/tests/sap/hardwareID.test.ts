import { describe, expect, it } from "vitest";
import { hardwareIDBytes } from "../../src/apple/sap/types";

describe("hardwareIDBytes", () => {
  it("decodes the hex rather than encoding its text", () => {
    const bytes = hardwareIDBytes("020000000000");
    expect(Array.from(bytes)).toEqual([0x02, 0, 0, 0, 0, 0]);
    // The text form would be twelve ASCII bytes, which binds the SAP session
    // to a different identity and gets the signature rejected with a bare 204.
    expect(bytes.length).toBe(6);
  });

  it("matches ipatool's uppercase guid for the same MAC bytes", () => {
    const mac = [0x12, 0xbd, 0x5c, 0x12, 0x1e, 0xe4];
    const guid = mac.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    expect(Array.from(hardwareIDBytes(guid))).toEqual(mac);
  });

  it.each(["", "abc", "zz", "0".repeat(42)])("rejects %o", (input) => {
    expect(() => hardwareIDBytes(input)).toThrow();
  });
});
