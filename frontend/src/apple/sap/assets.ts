// Fetches the Apple binaries the SAP signer runs under emulation.
//
// They total about 38 MB and never change — they come from a 2013 OS X
// release — so they are cached and reused. The backend serves them from
// DATA_DIR/sap; see tools/fetch-sap-assets.mjs for populating it.

import type { AssetBundle } from "./machine";

const CACHE_NAME = "sap-assets-v2";

const FILES = {
  commerceKit: "CommerceKit",
  commerceCore: "CommerceCore",
  coreFP: "CoreFP",
  coreFPICXS: "CoreFP.icxs",
} as const;

export interface AssetProgress {
  name: string;
  loaded: number;
  total: number;
}

/** Reports whether the backend has the assets, without downloading them. */
export async function assetsReady(
  headers: Record<string, string> = {},
): Promise<boolean> {
  try {
    const response = await fetch("/api/sap/assets", { headers });
    if (!response.ok) return false;
    return Boolean((await response.json()).ready);
  } catch {
    return false;
  }
}

async function fetchAsset(
  name: string,
  headers: Record<string, string>,
  onProgress?: (progress: AssetProgress) => void,
): Promise<Uint8Array> {
  const url = `/api/sap/assets/${name}`;

  // The Cache API is unavailable on insecure origins, so treat it as an
  // optimisation rather than a requirement.
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      onProgress?.({ name, loaded: bytes.length, total: bytes.length });
      return bytes;
    }
  } catch {
    cache = null;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `failed to fetch SAP asset ${name}`);
  }

  try {
    await cache?.put(url, response.clone());
  } catch {
    // A full or unavailable cache only costs a re-download next time.
  }

  const total = Number(response.headers.get("Content-Length") ?? 0);
  if (!response.body || !onProgress) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress({ name, loaded, total });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

export async function loadAssets(
  headers: Record<string, string> = {},
  onProgress?: (progress: AssetProgress) => void,
): Promise<AssetBundle> {
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([key, name]) => {
      return [key, await fetchAsset(name, headers, onProgress)] as const;
    }),
  );

  return Object.fromEntries(entries) as unknown as AssetBundle;
}
