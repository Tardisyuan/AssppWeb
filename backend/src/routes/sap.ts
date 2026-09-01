import { Router, Request, Response } from "express";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { config } from "../config.js";

// Serves the four Apple binaries the browser-side SAP signer runs under
// emulation. They are public components of a 2013 OS X release, carry no
// credentials, and are identical for every user, so they are plain static
// files rather than anything per-account.
//
// They are not in the image: they are large, they belong to Apple, and the
// signer only needs them when someone signs in. Populate DATA_DIR/sap with
// tools/fetch-sap-assets.mjs.

const router = Router();

// Names and sizes as ipatool's internal/sap/assets records them. The size
// check is what turns a truncated or wrong file into a clear error here
// rather than a mysterious emulator fault in the browser.
const ASSETS: Record<string, number> = {
  CommerceKit: 3271840,
  CommerceCore: 207744,
  CoreFP: 29014912,
  "CoreFP.icxs": 5288352,
};

function assetDirectory(): string {
  return path.join(config.dataDir, "sap");
}

router.get("/sap/assets", async (_req: Request, res: Response) => {
  const available: string[] = [];
  const missing: string[] = [];

  for (const [name, size] of Object.entries(ASSETS)) {
    try {
      const info = await stat(path.join(assetDirectory(), name));
      if (info.size === size) available.push(name);
      else missing.push(name);
    } catch {
      missing.push(name);
    }
  }

  res.json({ available, missing, ready: missing.length === 0 });
});

router.get("/sap/assets/:name", async (req: Request, res: Response) => {
  const name = req.params.name;
  const expected = ASSETS[name];

  // Only the four known names, so the parameter can never walk the filesystem.
  if (expected === undefined) {
    res.status(404).json({ error: "Unknown SAP asset" });
    return;
  }

  const file = path.join(assetDirectory(), name);

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    res.status(503).json({
      error: `SAP asset ${name} is not installed`,
      hint: "run tools/fetch-sap-assets.mjs to populate DATA_DIR/sap",
    });
    return;
  }

  if (size !== expected) {
    res.status(500).json({
      error: `SAP asset ${name} is ${size} bytes, expected ${expected}`,
    });
    return;
  }

  res.type("application/octet-stream");
  res.setHeader("Content-Length", String(size));
  // Immutable: these are fixed files from a 2013 release.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  createReadStream(file).pipe(res);
});

export default router;
