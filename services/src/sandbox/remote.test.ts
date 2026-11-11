import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remoteSandbox } from "./remote.js";
import { SandboxGone, type ExecResult, type Sandbox } from "./sandbox.js";
import { startSandboxServer } from "./server.js";

const execResult: ExecResult = { stdout: "hi\n", stderr: "warn", exitCode: 3, timedOut: true };

function memorySandbox(): Sandbox {
  const files = new Map<string, Uint8Array>();
  return {
    start: async () => "h1",
    exec: async () => execResult,
    writeFiles: async (_h, list) => { for (const f of list) files.set(f.path, f.bytes); },
    readFiles: async (_h, paths) => paths.map((path) => ({ path, bytes: files.get(path)! })),
    removeFiles: async () => {},
    stop: async () => { throw new SandboxGone("gone"); },
  };
}

describe("remoteSandbox through startSandboxServer", () => {
  let server: Server;
  let remote: Sandbox;
  beforeAll(async () => {
    server = startSandboxServer(memorySandbox(), { port: 0 });
    await once(server, "listening");
    remote = remoteSandbox(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
  afterAll(() => { server.close(); });

  it("round-trips bytes through writeFiles and readFiles", async () => {
    const handle = await remote.start({ runId: "r1", internet: false });
    await remote.writeFiles(handle, [{ path: "a/b.bin", bytes: new Uint8Array([0, 255, 10]) }]);
    const [file] = await remote.readFiles(handle, ["a/b.bin"]);
    expect(file.path).toBe("a/b.bin");
    expect([...file.bytes]).toEqual([0, 255, 10]);
  });

  it("passes an exec result through unchanged", async () => {
    expect(await remote.exec("h1", { language: "shell", code: "echo hi", timeoutSec: 5 })).toEqual(execResult);
  });

  it("rejects with SandboxGone when the session is gone", async () => {
    await expect(remote.stop("h1")).rejects.toBeInstanceOf(SandboxGone);
  });
});
