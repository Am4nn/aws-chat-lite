import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerSandbox, SANDBOX_IMAGE } from "./docker.js";
import { LIST_CODE, parseListing } from "./listing.js";
import { SandboxGone } from "./sandbox.js";

const imageBuilt = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE]).status === 0;
const sandbox = dockerSandbox();
const sh = (handle: string, code: string, timeoutSec = 30) => sandbox.exec(handle, { language: "shell", code, timeoutSec });
const bin = new Uint8Array([0, 255, 10]);
const oddName = `it's "x".txt`;

// Needs Docker and the image (npm run sandbox:build), not Floci.
describe.skipIf(!imageBuilt)("dockerSandbox", () => {
  let handle: string;
  beforeAll(async () => { handle = await sandbox.start({ runId: "docker-int", internet: false }); });
  afterAll(() => sandbox.stop(handle));

  it("has no internet by default", async () => {
    const r = await sandbox.exec(handle, {
      language: "python", code: "import urllib.request as u; u.urlopen('https://example.com', timeout=5)", timeoutSec: 30,
    });
    expect(r.exitCode).not.toBe(0);
  });

  it("reaches the internet when the room allows it", async () => {
    const online = await sandbox.start({ runId: "docker-int-online", internet: true });
    try {
      expect((await sh(online, "getent hosts example.com")).exitCode).toBe(0);
    } finally {
      await sandbox.stop(online);
    }
  });

  it("holds no secrets and runs as user 1000", async () => {
    const env = (await sh(handle, "env")).stdout.split("\n");
    expect(env.filter((line) => /AWS_|KEY|SECRET|TOKEN/.test(line))).toEqual([]);
    expect((await sh(handle, "id -u")).stdout.trim()).toBe("1000");
  });

  it("round-trips odd names byte-exact", async () => {
    await sandbox.writeFiles(handle, [{ path: "a/b.bin", bytes: bin }, { path: oddName, bytes: new TextEncoder().encode("q") }]);
    const files = await sandbox.readFiles(handle, ["a/b.bin", oddName]);
    expect(files.map((f) => [f.path, [...f.bytes]])).toEqual([["a/b.bin", [0, 255, 10]], [oddName, [113]]]);
  });

  it("lists regular workspace files, not symlinks or skipped folders", async () => {
    expect((await sh(handle, "ln -s /etc/passwd link && mkdir -p .venv && echo y > .venv/y")).exitCode).toBe(0);
    const listed = parseListing((await sandbox.exec(handle, { language: "python", code: LIST_CODE, timeoutSec: 30 })).stdout);
    const paths = listed.map((f) => f.path);
    expect(listed.find((f) => f.path === "a/b.bin")?.sha256).toBe(createHash("sha256").update(bin).digest("hex"));
    expect(paths).toContain(oddName);
    expect(paths).not.toContain("link");
    expect(paths).not.toContain(".venv/y");
  });

  it("times out a long exec", async () => {
    const started = Date.now();
    expect((await sh(handle, "sleep 10", 1)).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("removes files", async () => {
    await sandbox.removeFiles(handle, ["a/b.bin"]);
    await expect(sandbox.readFiles(handle, ["a/b.bin"])).rejects.toThrow();
  });

  it("is gone after stop, and a second stop resolves", async () => {
    await sandbox.stop(handle);
    await expect(sh(handle, "true")).rejects.toBeInstanceOf(SandboxGone);
    await expect(sandbox.stop(handle)).resolves.toBeUndefined();
  });
});
