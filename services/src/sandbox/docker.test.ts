import { describe, expect, it } from "vitest";
import { dockerSandbox, type DockerResult } from "./docker.js";
import { SandboxGone } from "./sandbox.js";

const ID = "a".repeat(64);

/** A fake docker CLI: `reply` answers each call by its argv; inspect says "a running sandbox" unless told otherwise. */
function fakeDocker(reply: (args: string[]) => Partial<DockerResult> | Promise<Partial<DockerResult>> = () => ({})) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    const fallback = args[1] === "inspect" ? { stdout: Buffer.from("1 true\n") } : {};
    return { code: 0, stdout: Buffer.alloc(0), stderr: "", ...fallback, ...(await reply(args)) };
  };
  return { calls, sandbox: dockerSandbox({ run, allowInternet: true }) };
}

const LIMITS = [
  "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "256", "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--user", "1000:1000", "-w", "/workspace", "cl-sandbox:1", "sleep", "900",
];
const exec = { language: "shell" as const, code: "true", timeoutSec: 1 };
const start = { runId: "r1", lifetimeSec: 900 };

describe("dockerSandbox", () => {
  it("starts an offline session with no network, env, mounts or privileges", async () => {
    const { calls, sandbox } = fakeDocker(() => ({ stdout: Buffer.from(`${ID}\n`) }));
    expect(await sandbox.start({ ...start, internet: false })).toEqual({ handle: ID, internet: false });
    expect(calls).toEqual([["run", "-d", "--rm", "--label", "cl-sandbox=1", "--label", "cl-run=r1", "--network", "none", ...LIMITS]]);
  });

  it("puts an online session on the sandbox network, with the host's names pointed at loopback", async () => {
    const { calls, sandbox } = fakeDocker(() => ({ stdout: Buffer.from(ID) }));
    expect(await sandbox.start({ ...start, internet: true })).toEqual({ handle: ID, internet: true });
    expect(calls[0]).toEqual([
      "run", "-d", "--rm", "--label", "cl-sandbox=1", "--label", "cl-run=r1", "--network", "cl-sandbox-net",
      "--add-host", "host.docker.internal:127.0.0.1", "--add-host", "gateway.docker.internal:127.0.0.1", ...LIMITS,
    ]);
    expect(calls[0].filter((a) => ["-e", "--env", "-v", "--volume", "--mount", "--privileged"].includes(a))).toEqual([]);
  });

  it("starts every session offline on a machine that hasn't opted in to internet", async () => {
    const calls: string[][] = [];
    const sandbox = dockerSandbox({ run: async (args) => { calls.push(args); return { code: 0, stdout: Buffer.from(ID), stderr: "" }; } });
    expect(await sandbox.start({ ...start, internet: true })).toEqual({ handle: ID, internet: false });
    expect(calls[0]).toContain("none");
    expect(calls[0]).not.toContain("cl-sandbox-net");
  });

  it("passes -- before every path, so a name starting with a dash is never an option", async () => {
    const { calls, sandbox } = fakeDocker();
    await sandbox.writeFiles(ID, [{ path: "-n/x", bytes: new Uint8Array() }]);
    await sandbox.readFiles(ID, ["-notes.txt"]);
    const [write, read] = calls.filter((a) => a[0] === "exec");
    expect(write!.slice(3)).toEqual(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", "-n/x"]);
    expect(read!.slice(2)).toEqual(["head", "-c", "26214401", "--", "-notes.txt"]);
  });

  it("refuses a handle that isn't a full container id, without calling docker", async () => {
    const { calls, sandbox } = fakeDocker();
    await expect(sandbox.exec("floci", exec)).rejects.toThrow(/not a sandbox/);
    await expect(sandbox.stop("floci")).rejects.toThrow(/not a sandbox/);
    expect(calls).toEqual([]);
  });

  it("refuses a container without the sandbox label", async () => {
    const { calls, sandbox } = fakeDocker((args) => (args[1] === "inspect" ? { stdout: Buffer.from(" true\n") } : {}));
    await expect(sandbox.exec(ID, exec)).rejects.toThrow(/not a sandbox/);
    await expect(sandbox.readFiles(ID, ["a"])).rejects.toThrow(/not a sandbox/);
    await expect(sandbox.stop(ID)).rejects.toThrow(/not a sandbox/);
    expect(calls.map((a) => a[0] + " " + a[1])).toEqual(["container inspect", "container inspect", "container inspect"]);
  });

  it("reports a missing or stopped container as gone, and stop of a gone one resolves", async () => {
    const missing = fakeDocker(() => ({ code: 1, stderr: `Error response from daemon: No such container: ${ID}\n` }));
    await expect(missing.sandbox.exec(ID, exec)).rejects.toBeInstanceOf(SandboxGone);
    await expect(missing.sandbox.stop(ID)).resolves.toBeUndefined();
    const stopped = fakeDocker((args) => (args[1] === "inspect" ? { stdout: Buffer.from("1 false\n") } : {}));
    await expect(stopped.sandbox.writeFiles(ID, [{ path: "a", bytes: new Uint8Array() }])).rejects.toBeInstanceOf(SandboxGone);
  });

  it("doesn't take code's own stderr for a gone session", async () => {
    const { sandbox } = fakeDocker((args) => (args[0] === "exec" ? { code: 1, stderr: "Error response from daemon: No such container: x\n" } : {}));
    expect(await sandbox.exec(ID, exec)).toMatchObject({ exitCode: 1, timedOut: false });
  });

  it("calls exit 124 a timeout", async () => {
    const { sandbox } = fakeDocker((args) => (args[0] === "exec" ? { code: 124 } : {}));
    expect(await sandbox.exec(ID, exec)).toMatchObject({ exitCode: 124, timedOut: true });
  });

  it("calls an early 137 a kill, and a 137 at the time limit a timeout", async () => {
    const early = fakeDocker((args) => (args[0] === "exec" ? { code: 137, stderr: "x" } : {}));
    const result = await early.sandbox.exec(ID, { ...exec, timeoutSec: 5 });
    expect(result).toMatchObject({ exitCode: 137, timedOut: false });
    expect(result.stderr).toBe("x\nkilled (likely out of memory)");
    const late = fakeDocker(async (args) => {
      if (args[0] !== "exec") return {};
      // Past the 1 s limit with room to spare: a timer can fire a millisecond early against Date.now().
      await new Promise((r) => setTimeout(r, 1100));
      return { code: 137 };
    });
    expect(await late.sandbox.exec(ID, exec)).toMatchObject({ exitCode: 137, timedOut: true });
  });
});
