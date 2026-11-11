import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerSandbox, ensureSandboxNetwork, runDocker, SANDBOX_IMAGE, SANDBOX_NETWORK } from "./docker.js";
import { SandboxGone } from "./sandbox.js";
import { LIST_CODE, parseListing, removeCode } from "./scripts.js";

const imageBuilt = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE]).status === 0;
const sandbox = dockerSandbox();
const sh = (handle: string, code: string, timeoutSec = 30) => sandbox.exec(handle, { language: "shell", code, timeoutSec });
const list = async (handle: string) => parseListing((await sh(handle, LIST_CODE, 60)).stdout);
const bin = new Uint8Array([0, 255, 10]);
const oddName = `it's "x".txt`;
const start = (runId: string, internet = false) => ({ runId, internet, lifetimeSec: 600 });

// Needs Docker and the image (npm run sandbox:build), not Floci.
describe.skipIf(!imageBuilt)("dockerSandbox", { timeout: 60_000 }, () => {
  let handle: string;
  beforeAll(async () => {
    await ensureSandboxNetwork();
    ({ handle } = await sandbox.start(start("docker-int")));
  });
  afterAll(() => sandbox.stop(handle));

  it("has no internet by default", async () => {
    const r = await sandbox.exec(handle, {
      language: "python", code: "import urllib.request as u; u.urlopen('https://example.com', timeout=5)", timeoutSec: 30,
    });
    expect(r.exitCode).not.toBe(0);
  });

  it("keeps a room that allows internet offline on a machine that hasn't opted in", async () => {
    const offline = await sandbox.start(start("docker-int-wanted", true));
    try {
      expect(offline.internet).toBe(false);
      expect((await sh(offline.handle, "getent hosts example.com")).exitCode).not.toBe(0);
    } finally {
      await sandbox.stop(offline.handle);
    }
  });

  it("reaches the internet when the room allows it and this machine opted in", async () => {
    const online = await dockerSandbox({ allowInternet: true }).start(start("docker-int-online", true));
    try {
      expect(online.internet).toBe(true);
      expect((await sh(online.handle, "getent hosts example.com")).exitCode).toBe(0);
      expect((await sh(online.handle, "getent hosts host.docker.internal")).stdout).toMatch(/^127\.0\.0\.1\s/);
    } finally {
      await sandbox.stop(online.handle);
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

  it("round-trips odd names byte-exact, a name starting with a dash included", async () => {
    const q = new TextEncoder().encode("q");
    await sandbox.writeFiles(handle, [{ path: "a/b.bin", bytes: bin }, { path: oddName, bytes: q }, { path: "-n/-notes.txt", bytes: q }]);
    const files = await sandbox.readFiles(handle, ["a/b.bin", oddName, "-n/-notes.txt"]);
    expect(files.map((f) => [f.path, [...f.bytes]])).toEqual([["a/b.bin", [0, 255, 10]], [oddName, [113]], ["-n/-notes.txt", [113]]]);
  });

  it("lists regular workspace files, not symlinks or skipped folders", async () => {
    expect((await sh(handle, "ln -s /etc/passwd link && mkdir -p .venv && echo y > .venv/y")).exitCode).toBe(0);
    const listed = await list(handle);
    const paths = listed.files.map((f) => f.path);
    expect(listed.files.find((f) => f.path === "a/b.bin")?.sha256).toBe(createHash("sha256").update(bin).digest("hex"));
    expect(paths).toContain(oddName);
    expect(paths).not.toContain("link");
    expect(paths).not.toContain(".venv/y");
  });

  it("lists even when the workspace and the user's site-packages hold modules named like the listing's imports", async () => {
    const planted = await sh(handle, [
      `site=$(python3 -c 'import site; print(site.getusersitepackages())')`,
      `mkdir -p "$site"`,
      `echo 'import sys; sys.exit("hijacked")' > "$site/usercustomize.py"`,
      `echo 'import os; os._exit(3)' > "$site/evil.pth"`,
      `for m in json hashlib os stat; do echo 'raise SystemExit("hijacked")' > $m.py; done`,
    ].join(" && "));
    expect(planted).toMatchObject({ exitCode: 0, stderr: "" });
    // Planted for real: Python run the ordinary way picks them up.
    expect((await sh(handle, "python3 -c 'import json'")).exitCode).not.toBe(0);
    expect((await list(handle)).files.map((f) => f.path)).toContain("json.py");
    await sh(handle, `rm -f json.py hashlib.py os.py stat.py; rm -rf "$HOME/.local"`);
  });

  it("reports an unreadable file or folder, and a name that isn't UTF-8, instead of failing", async () => {
    expect((await sh(handle, "echo x > locked && chmod 000 locked && mkdir -p shut && echo y > shut/in && chmod 000 shut && printf z > \"$(printf 'x\\377y')\"")).exitCode).toBe(0);
    const listed = await list(handle);
    expect(listed.unreadable.sort()).toEqual(["locked", "shut"]);
    expect(listed.badNames).toEqual(["x�y"]);
    expect(listed.files.map((f) => f.path)).not.toContain("locked");
    await sh(handle, `chmod 700 shut && rm -rf locked shut "$(printf 'x\\377y')"`);
  });

  it("reports a file too big for the room by size without hashing it, and reads back at most one byte over the limit", async () => {
    expect((await sh(handle, "truncate -s 900M huge.bin")).exitCode).toBe(0);
    const listed = await list(handle);
    expect(listed.files.find((f) => f.path === "huge.bin")).toEqual({ path: "huge.bin", size: 900 * 1024 * 1024, sha256: "" });
    const [file] = await sandbox.readFiles(handle, ["huge.bin"]);
    expect(file!.bytes.length).toBe(26_214_401);
    await sh(handle, "rm huge.bin");
  });

  it("caps the listing and counts what it left out", async () => {
    expect((await sh(handle, "mkdir many && cd many && seq 1 2500 | xargs touch")).exitCode).toBe(0);
    const listed = await list(handle);
    expect(listed.files.length + listed.unreadable.length + listed.badNames.length).toBe(2000);
    expect(listed.more).toBeGreaterThan(500);
    await sh(handle, "rm -rf many");
  });

  it("removes files and the folders that leaves empty, so a file can take a folder's place", async () => {
    await sandbox.writeFiles(handle, [{ path: "out/x/y", bytes: bin }, { path: "keep/z", bytes: bin }, { path: "keep/w", bytes: bin }]);
    expect((await sh(handle, removeCode(["out/x/y", "keep/z", "not-there"]))).exitCode).toBe(0);
    await sandbox.writeFiles(handle, [{ path: "out", bytes: bin }]);
    expect((await sh(handle, "test -f out && test -f keep/w && test ! -e keep/z && echo ok")).stdout).toBe("ok\n");
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

  it("ends a running exec at once when its session is stopped", async () => {
    const doomed = await sandbox.start(start("docker-int-stop"));
    const started = Date.now();
    const running = sh(doomed.handle, "sleep 30", 60).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await sandbox.stop(doomed.handle);
    await running;
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("is gone after stop, and a second stop resolves", async () => {
    await sandbox.stop(handle);
    await expect(sh(handle, "true")).rejects.toBeInstanceOf(SandboxGone);
    await expect(sandbox.stop(handle)).resolves.toBeUndefined();
  });
});
