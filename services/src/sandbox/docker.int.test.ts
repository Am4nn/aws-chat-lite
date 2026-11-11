import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerSandbox, ensureSandboxNetwork, runDocker, SANDBOX_IMAGE, SANDBOX_NETWORK } from "./docker.js";
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
  beforeAll(async () => {
    await ensureSandboxNetwork();
    handle = await sandbox.start({ runId: "docker-int", internet: false });
  });
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
      expect((await sh(online, "getent hosts host.docker.internal")).stdout).toMatch(/^127\.0\.0\.1\s/);
    } finally {
      await sandbox.stop(online);
    }
  });

  it("keeps online sessions apart from each other", async () => {
    const { stdout } = await runDocker(["network", "inspect", "--format", "{{json .Options}}", SANDBOX_NETWORK]);
    expect(JSON.parse(stdout.toString())).toMatchObject({ "com.docker.network.bridge.enable_icc": "false" });
  });

  it("refuses a container that isn't a sandbox", async () => {
    const other = (await runDocker(["run", "-d", "--rm", "alpine:3.21", "sleep", "60"])).stdout.toString().trim();
    try {
      await expect(sh(other, "true")).rejects.toThrow(/not a sandbox/);
      await expect(sandbox.stop(other)).rejects.toThrow(/not a sandbox/);
      expect((await runDocker(["container", "inspect", other])).code).toBe(0);
    } finally {
      await runDocker(["rm", "-f", other]);
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

  it("reports a kill before the time limit as a kill, not a timeout", async () => {
    const r = await sh(handle, "kill -9 $$");
    expect(r).toMatchObject({ exitCode: 137, timedOut: false });
    expect(r.stderr).toContain("killed (likely out of memory)");
  });

  it("keeps only the last 1 MB of a flood of output", async () => {
    const { stdout } = await sh(handle, "head -c 3000000 /dev/zero | tr '\\0' a");
    expect(stdout.startsWith("… (1951424 earlier bytes cut)\na")).toBe(true);
    expect(stdout.endsWith("a".repeat(1024 * 1024))).toBe(true);
  });

  it("survives code that exits before reading all of its stdin", async () => {
    expect((await sh(handle, "exit 3\n" + "#".repeat(5_000_000))).exitCode).toBe(3);
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
