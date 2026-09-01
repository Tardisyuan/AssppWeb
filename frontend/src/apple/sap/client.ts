// Main-thread handle on the SAP signer worker.
//
// Apple began requiring a SAP signature on authenticate in August 2026, and
// producing one means emulating Apple's own signing code. Measured in Chrome
// on a laptop: setup takes about 115 seconds and each signature about 12.
// Setup happens once per session, a signature once per sign-in attempt, and
// both are slow enough to need saying so on screen.
//
// The signer is created lazily, so a session that never signs in never pays
// for it, and the assets are only fetched when they are about to be used.

import { getAccessToken } from "../../components/Auth/PasswordGate";
import type { AssetProgress } from "./assets";
import type { WorkerRequest, WorkerResponse } from "./worker";

export type SetupProgress =
  | { phase: "assets"; asset: AssetProgress }
  | { phase: "setup" }
  | { phase: "signing" };

const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;

const pending = new Map<
  number,
  { resolve: (signature: Uint8Array) => void; reject: (error: Error) => void }
>();

let onProgress: ((progress: SetupProgress) => void) | null = null;
let settleSetup: { resolve: () => void; reject: (error: Error) => void } | null = null;

function handle(event: MessageEvent<WorkerResponse>) {
  const message = event.data;

  if (message.type === "progress") {
    onProgress?.(
      message.phase === "assets"
        ? { phase: "assets", asset: message.asset }
        : { phase: "setup" },
    );
    return;
  }

  if (message.type === "ready") {
    settleSetup?.resolve();
    settleSetup = null;
    return;
  }

  if (message.type === "signed") {
    pending.get(message.id)?.resolve(message.signature);
    pending.delete(message.id);
    return;
  }

  const error = new Error(message.message);
  if (message.id !== undefined) {
    pending.get(message.id)?.reject(error);
    pending.delete(message.id);
    return;
  }

  settleSetup?.reject(error);
  settleSetup = null;
  // A failed setup leaves nothing usable, so let the next attempt start over.
  reset(error);
}

function reset(error: Error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();

  worker?.terminate();
  worker = null;
  ready = null;
}

/**
 * Prepares the signer, reusing it if it already exists. Safe to call more
 * than once; concurrent callers share the same setup.
 */
export function prepareSigner(
  hardwareID: string,
  progress?: (progress: SetupProgress) => void,
): Promise<void> {
  onProgress = progress ?? null;

  if (ready) return ready;

  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = handle;
  worker.onerror = (event) => {
    reset(new Error(event.message || "SAP signer worker failed"));
  };

  // Without this a worker that wedges — a stalled fetch, an emulator that
  // never returns — leaves the caller waiting forever with nothing on screen
  // and no request ever going out. Generous, because a cold deployment has to
  // fetch 38 MB from Apple before it can even start.
  ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out preparing the SAP signer"));
      reset(new Error("timed out preparing the SAP signer"));
    }, SETUP_TIMEOUT_MS);

    settleSetup = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
  });

  const request: WorkerRequest = {
    type: "setup",
    hardwareID: hexToBytes(hardwareID),
    // sessionStorage exists only here, not in the worker.
    accessToken: getAccessToken(),
  };
  worker.postMessage(request);

  return ready;
}

/** Signs a request body. The signer must have been prepared first. */
export function signAction(payload: Uint8Array): Promise<Uint8Array> {
  if (!worker || !ready) {
    return Promise.reject(new Error("SAP signer is not prepared"));
  }

  return ready.then(
    () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });

        const request: WorkerRequest = { type: "sign", id, payload };
        worker!.postMessage(request, [payload.buffer]);
      }),
  );
}

/** The guid is hex; the signer wants the bytes behind it. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || clean.length > 40) {
    throw new Error("device identifier must be 1 to 20 hex-encoded bytes");
  }

  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}
