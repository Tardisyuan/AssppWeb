/// <reference lib="webworker" />
// The SAP signer, off the main thread.
//
// Setting one up runs about ten million emulated instructions and takes the
// better part of a minute, which would freeze the tab. Signing afterwards is
// fast, so the worker is set up once and kept for the session.

import { loadAssets, type AssetProgress } from "./assets";
import { Signer, type Transport } from "./signer";

export type WorkerRequest =
  | { type: "setup"; hardwareID: Uint8Array }
  | { type: "sign"; id: number; payload: Uint8Array };

export type WorkerResponse =
  | { type: "progress"; phase: "assets"; asset: AssetProgress }
  | { type: "progress"; phase: "setup" }
  | { type: "ready" }
  | { type: "signed"; id: number; signature: Uint8Array }
  | { type: "error"; id?: number; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

// The setup endpoints are proxied by the backend; nothing here is secret.
const transport: Transport = async ({ method, url, body }) => {
  const response = await fetch(url, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/x-plist" } : {},
    body: body ? new Blob([body as BlobPart]) : undefined,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `SAP setup request failed (${response.status})`);
  }

  return new Uint8Array(await response.arrayBuffer());
};

let signer: Signer | null = null;

function post(message: WorkerResponse, transfer?: Transferable[]) {
  scope.postMessage(message, transfer ?? []);
}

async function setup(hardwareID: Uint8Array) {
  const bundle = await loadAssets((asset) => {
    post({ type: "progress", phase: "assets", asset });
  });

  post({ type: "progress", phase: "setup" });

  signer = await Signer.create(
    bundle,
    {
      // Routed through the backend rather than to Apple directly, so the
      // worker needs no tunnel of its own.
      setupURL: new URL("/api/sap/setup", scope.location.origin).toString(),
      certificateURL: new URL("/api/sap/certificate", scope.location.origin).toString(),
      version: 200,
      hardwareID,
    },
    transport,
  );

  post({ type: "ready" });
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === "setup") {
      if (signer) {
        post({ type: "ready" });
        return;
      }
      await setup(request.hardwareID);
      return;
    }

    if (!signer) throw new Error("SAP signer is not ready");

    const signature = signer.sign(request.payload);
    post({ type: "signed", id: request.id, signature }, [signature.buffer]);
  } catch (error) {
    post({
      type: "error",
      id: request.type === "sign" ? request.id : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
