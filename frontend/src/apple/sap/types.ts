// Shared SAP types.

export interface SapEndpoints {
  /** GET endpoint returning the Apple certificate plist (bag: sign-sap-setup-cert). */
  certificateURL: string;
  /** POST endpoint for the setup key exchange (bag: sign-sap-setup). */
  setupURL: string;
  /** Protocol version from the bag (sign-sap-version); only 200 is supported. */
  version: number;
}

export const SUPPORTED_SAP_VERSION = 200;

export interface SapAssetBundle {
  commerceKit: Uint8Array;
  commerceCore: Uint8Array;
  coreFP: Uint8Array;
  coreFPICXS: Uint8Array;
}

export interface SapSignerOptions extends SapEndpoints {
  /** Per-account device identifier bytes (ASCII, 1..20 bytes). */
  hardwareID: Uint8Array;
  assets: SapAssetBundle;
  wasmBinary?: ArrayBuffer;
}

/** Endpoint/hardware validation matching the Swift reference. */
export function validateSapSignerOptions(options: SapSignerOptions): void {
  if (options.version !== SUPPORTED_SAP_VERSION) {
    throw new Error(`unsupported SAP version ${options.version}`);
  }
  if (options.hardwareID.length === 0 || options.hardwareID.length > 20) {
    throw new Error("SAP hardware ID must contain between 1 and 20 bytes");
  }
  for (const url of [options.certificateURL, options.setupURL]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username) {
      throw new Error(`SAP endpoint must be an absolute HTTPS URL: ${url}`);
    }
  }
}

/**
 * The bytes behind the device identifier.
 *
 * The identifier is hex: ipatool derives it as the uppercase hex of a MAC
 * address and passes those raw bytes to the signer, so the guid in the request
 * and the identity in the SAP session describe the same device. Encoding the
 * hex text instead binds the session to a different identity — the signature
 * comes back the right shape and Apple rejects it with a bare 204.
 */
export function hardwareIDBytes(hardwareID: string): Uint8Array {
  const clean = hardwareID.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || clean.length > 40) {
    throw new Error("device identifier must be 1 to 20 hex-encoded bytes");
  }

  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}
