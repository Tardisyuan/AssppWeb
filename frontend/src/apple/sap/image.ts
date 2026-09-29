// A prebuilt guest image: the emulator's memory as it stands once the loader
// has finished, produced once at build time rather than assembled here.
//
// The images relocate deterministically — fixed bytes, fixed load bases, and
// shim addresses this side controls — so the result is reproducible and can be
// shipped as blobs. Given one, the browser maps the regions, writes the bytes,
// and binds handlers to the addresses the manifest names. macho.ts and the
// dyld bind/rebase opcodes are not needed at all.
//
// tools/dump-sap-image.sh builds it. When it is absent the loader path in
// machine.ts runs instead, so nothing here is required to sign in.

export interface ImageRegion {
  name: string;
  address: bigint;
  size: bigint;
  /** Absent for regions the guest only allocates into, which start zeroed. */
  data?: Uint8Array;
}

export interface GuestImage {
  regions: ImageRegion[];
  /** Shim slot addresses the images were relocated against. */
  symbols: Map<string, bigint>;
  /** Addresses inside the images, which the shim table does not carry. */
  exports: Map<string, bigint>;
}

interface ManifestSymbol {
  name: string;
  address: number;
}

interface ManifestRegion {
  name: string;
  address: number;
  size: number;
  blob?: string;
  sha256?: string;
}

interface Manifest {
  regions: ManifestRegion[];
  symbols: ManifestSymbol[];
  exports: ManifestSymbol[];
}

// JSON numbers lose precision above 2^53 and these addresses run to 2^46, so
// they survive as numbers — but everything downstream is BigInt.
function toMap(entries: ManifestSymbol[]): Map<string, bigint> {
  return new Map(entries.map((entry) => [entry.name, BigInt(entry.address)]));
}

/**
 * Fetches the prebuilt image, or returns null when the deployment has none.
 *
 * A missing image is the ordinary case and not an error: the backend only
 * serves one if it was built and placed in its data directory.
 */
export async function loadGuestImage(
  headers: Record<string, string> = {},
): Promise<GuestImage | null> {
  const response = await fetch("/api/sap/image/manifest.json", { headers });
  if (!response.ok) return null;

  const manifest = (await response.json()) as Manifest;

  const regions = await Promise.all(
    manifest.regions.map(async (region): Promise<ImageRegion> => {
      const base: ImageRegion = {
        name: region.name,
        address: BigInt(region.address),
        size: BigInt(region.size),
      };

      if (!region.blob) return base;

      const blob = await fetch(`/api/sap/image/${region.blob}`, { headers });
      if (!blob.ok) {
        throw new Error(`prebuilt SAP image is missing ${region.blob}`);
      }

      const data = new Uint8Array(await blob.arrayBuffer());
      if (BigInt(data.length) > base.size) {
        throw new Error(
          `${region.blob} is larger than the ${region.name} region`,
        );
      }

      return { ...base, data };
    }),
  );

  return {
    regions,
    symbols: toMap(manifest.symbols),
    exports: toMap(manifest.exports),
  };
}
