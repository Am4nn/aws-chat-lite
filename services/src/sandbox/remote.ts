import { SandboxGone, type ExecResult, type Sandbox, type WorkspaceFile } from "./sandbox.js";

/** File bytes travel as base64 inside JSON. */
type WireFile = { path: string; bytes: string };
export const toWire = (files: WorkspaceFile[]): WireFile[] =>
  files.map((f) => ({ path: f.path, bytes: Buffer.from(f.bytes).toString("base64") }));
export const fromWire = (files: WireFile[]): WorkspaceFile[] =>
  files.map((f) => ({ path: f.path, bytes: new Uint8Array(Buffer.from(f.bytes, "base64")) }));

/** A sandbox served by `startSandboxServer` at `url`; a 410 means the session is gone. */
export function remoteSandbox(url: string, fetchFn: typeof fetch = fetch): Sandbox {
  async function call<T>(op: string, body: object): Promise<T> {
    const res = await fetchFn(`${url}/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (res.status === 410) throw new SandboxGone(json.error);
    if (!res.ok) throw new Error(`Sandbox ${op} failed: ${json.error}`);
    return json as T;
  }

  return {
    start: async (o) => (await call<{ handle: string }>("start", o)).handle,
    exec: (handle, o) => call<ExecResult>("exec", { handle, ...o }),
    writeFiles: async (handle, files) => { await call("writeFiles", { handle, files: toWire(files) }); },
    readFiles: async (handle, paths) => fromWire((await call<{ files: WireFile[] }>("readFiles", { handle, paths })).files),
    removeFiles: async (handle, paths) => { await call("removeFiles", { handle, paths }); },
    stop: async (handle) => { await call("stop", { handle }); },
  };
}
