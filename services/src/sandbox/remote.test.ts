import { once } from "node:events";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { remoteSandbox } from "./remote.js";
import { SandboxGone, type ExecResult, type Sandbox } from "./sandbox.js";
import { startSandboxServer } from "./server.js";

const TOKEN = "test-token";
const HANDLE = "a".repeat(64);
const MB = 1024 * 1024;
const execResult: ExecResult = { stdout: "hi\n", stderr: "warn", exitCode: 3, timedOut: true };

function memorySandbox() {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const sandbox: Sandbox = {
    start: async (o) => ({ handle: HANDLE, internet: o.internet }),
    exec: async () => execResult,
    writeFiles: async (_h, list) => { calls.push("writeFiles"); for (const f of list) files.set(f.path, f.bytes); },
    readFiles: async (_h, paths) => { calls.push("readFiles"); return paths.map((path) => ({ path, bytes: files.get(path)! })); },
    stop: async () => { throw new SandboxGone("gone"); },
  };
  return { sandbox, calls };
}

type Raw = { headers?: Record<string, string>; body?: string };

describe("remoteSandbox through startSandboxServer", () => {
  const memory = memorySandbox();
  let server: Server;
  let url: string;
  let remote: Sandbox;
  let port: number;

  /** A request with full control of its headers (fetch won't let a caller set Host). */
  function raw(op: string, { headers = {}, body = "{}" }: Raw = {}): Promise<{ status: number; connection?: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port, method: "POST", path: `/${op}`,
        headers: { "content-type": "application/json", "x-sandbox-token": TOKEN, ...headers },
      }, (res) => {
        res.resume();
        resolve({ status: res.statusCode!, connection: res.headers.connection });
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  beforeAll(async () => {
    server = startSandboxServer(memory.sandbox, { token: TOKEN, port: 0 });
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
    remote = remoteSandbox(url, TOKEN);
  });
  afterAll(() => { server.close(); });
  beforeEach(() => { memory.calls.length = 0; });

  it("won't start without a token", () => {
    expect(() => startSandboxServer(memory.sandbox, { token: "", port: 0 })).toThrow(/token/);
  });

  it("round-trips bytes through writeFiles and readFiles", async () => {
    const { handle } = await remote.start({ runId: "r1", internet: false, lifetimeSec: 60 });
    await remote.writeFiles(handle, [{ path: "a/b.bin", bytes: new Uint8Array([0, 255, 10]) }]);
    const [file] = await remote.readFiles(handle, ["a/b.bin"]);
    expect(file.path).toBe("a/b.bin");
    expect([...file.bytes]).toEqual([0, 255, 10]);
  });

  it("says whether the session it started has internet", async () => {
    expect(await remote.start({ runId: "r1", internet: true, lifetimeSec: 60 })).toEqual({ handle: HANDLE, internet: true });
  });

  it("passes an exec result through unchanged", async () => {
    expect(await remote.exec(HANDLE, { language: "shell", code: "echo hi", timeoutSec: 5 })).toEqual(execResult);
  });

  it("rejects with SandboxGone when the session is gone", async () => {
    await expect(remote.stop(HANDLE)).rejects.toBeInstanceOf(SandboxGone);
  });

  it("refuses a wrong or missing token", async () => {
    await expect(remoteSandbox(url, "wrong").start({ runId: "r1", internet: false, lifetimeSec: 60 })).rejects.toThrow(/token/);
    expect((await raw("start", { headers: { "x-sandbox-token": "" } })).status).toBe(401);
  });

  it("refuses another Host (a web page rebinding its DNS) and a body that isn't JSON", async () => {
    expect((await raw("stop", { headers: { host: `evil.example:${port}` }, body: `{"handle":"${HANDLE}"}` })).status).toBe(403);
    expect((await raw("stop", { headers: { "content-type": "text/plain" }, body: `{"handle":"${HANDLE}"}` })).status).toBe(415);
    expect((await raw("stop", { headers: { host: `host.docker.internal:${port}` }, body: `{"handle":"${HANDLE}"}` })).status).toBe(410);
  });

  it("answers 400 to invalid JSON or a field of the wrong type", async () => {
    expect((await raw("start", { body: "{nope" })).status).toBe(400);
    expect((await raw("start", { body: '{"runId":"r1","internet":"yes","lifetimeSec":60}' })).status).toBe(400);
    expect((await raw("start", { body: '{"runId":"r1","internet":true,"lifetimeSec":0}' })).status).toBe(400);
    expect((await raw("exec", { body: `{"handle":"${HANDLE}","language":"ruby","code":"x","timeoutSec":5}` })).status).toBe(400);
    expect((await raw("exec", { body: `{"handle":"${HANDLE}","language":"shell","code":"x","timeoutSec":301}` })).status).toBe(400);
    expect((await raw("stop", { body: '{"handle":"floci"}' })).status).toBe(400);
    expect((await raw("readFiles", { body: `{"handle":"${HANDLE}","paths":[1]}` })).status).toBe(400);
  });

  it("answers 413 from content-length alone and closes the connection", async () => {
    const res = await raw("writeFiles", { headers: { "content-length": String(65 * MB) }, body: "" });
    expect(res).toEqual({ status: 413, connection: "close" });
  });

  it("sends writes in batches of about 40 MB and reads one file per request", async () => {
    const files = ["x", "y", "z"].map((path) => ({ path, bytes: new Uint8Array(15 * MB) }));
    await remote.writeFiles(HANDLE, files);
    expect(memory.calls).toEqual(["writeFiles", "writeFiles"]);
    const read = await remote.readFiles(HANDLE, ["x", "y", "z"]);
    expect(read.map((f) => [f.path, f.bytes.length])).toEqual([["x", 15 * MB], ["y", 15 * MB], ["z", 15 * MB]]);
    expect(memory.calls.slice(2)).toEqual(["readFiles", "readFiles", "readFiles"]);
  });

  it("says so when a request is over the server's limit", async () => {
    await expect(remote.writeFiles(HANDLE, [{ path: "big", bytes: new Uint8Array(50 * MB) }])).rejects.toThrow(/64 MB/);
  });
});
