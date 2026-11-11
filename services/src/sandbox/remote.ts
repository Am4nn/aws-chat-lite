import { Agent, fetch } from "undici";
import { SandboxGone, type ExecResult, type Sandbox, type WorkspaceFile } from "./sandbox.js";

/** File bytes travel as base64 inside JSON. */
type WireFile = { path: string; bytes: string };
export const toWire = (files: WorkspaceFile[]): WireFile[] =>
  files.map((f) => ({ path: f.path, bytes: Buffer.from(f.bytes).toString("base64") }));
export const fromWire = (files: WireFile[]): WorkspaceFile[] =>
  files.map((f) => ({ path: f.path, bytes: new Uint8Array(Buffer.from(f.bytes, "base64")) }));

// Undici's default 300 s wait for response headers is shorter than the longest exec (300 s plus the kill grace).
const dispatcher = new Agent({ headersTimeout: 330_000, bodyTimeout: 330_000 });

export const BODY_LIMIT = 64 * 1024 * 1024;
// 40 MB of bytes is about 53 MB as base64, under the body limit.
const BATCH_BYTES = 40 * 1024 * 1024;

function batches(files: WorkspaceFile[]): WorkspaceFile[][] {
  const out: WorkspaceFile[][] = [];
  let size = Infinity;
  for (const file of files) {
    if (size + file.bytes.length > BATCH_BYTES) {
      out.push([]);
      size = 0;
    }
    out[out.length - 1].push(file);
    size += file.bytes.length;
  }
  return out;
}

/** A sandbox served by `startSandboxServer` at `url`, which takes `token`; a 410 means the session is gone. */
export function remoteSandbox(url: string, token: string): Sandbox {
  const tooBig = (op: string) => new Error(`Sandbox ${op} would send more than the server's 64 MB limit.`);
  async function call<T>(op: string, args: object): Promise<T> {
    const body = JSON.stringify(args);
    // Checked here too: the server closes the connection on an oversized body, which fetch reports only as "fetch failed".
    if (Buffer.byteLength(body) > BODY_LIMIT) throw tooBig(op);
    const res = await fetch(`${url}/${op}`, {
      method: "POST", dispatcher, body,
      headers: { "content-type": "application/json", "x-sandbox-token": token },
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 410) throw new SandboxGone(json.error);
    if (res.status === 401) throw new Error("The sandbox server refused this function's token. Run npm run deploy:local again.");
    if (res.status === 413) throw tooBig(op);
    if (!res.ok) throw new Error(`Sandbox ${op} failed (${res.status}): ${json.error}`);
    return json as T;
  }

  return {
    start: async (o) => (await call<{ handle: string }>("start", o)).handle,
    exec: (handle, o) => call<ExecResult>("exec", { handle, ...o }),
    writeFiles: async (handle, files) => {
      for (const batch of batches(files)) await call("writeFiles", { handle, files: toWire(batch) });
    },
    // One file per response: sizes aren't known up front, and a single file can be 25 MB.
    readFiles: async (handle, paths) => {
      const files = [];
      for (const path of paths) files.push(...fromWire((await call<{ files: WireFile[] }>("readFiles", { handle, paths: [path] })).files));
      return files;
    },
    removeFiles: async (handle, paths) => { await call("removeFiles", { handle, paths }); },
    stop: async (handle) => { await call("stop", { handle }); },
  };
}
