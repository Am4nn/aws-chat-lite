import { spawn } from "node:child_process";
import { SandboxGone, type Language, type Sandbox } from "./sandbox.js";

export const SANDBOX_IMAGE = "cl-sandbox:1";
export const SANDBOX_NETWORK = "cl-sandbox-net";
const LABEL = "cl-sandbox=1";

/** Handles are full container ids, so a name like `floci` can never reach another container. */
export const isHandle = (handle: unknown): handle is string => typeof handle === "string" && /^[0-9a-f]{64}$/.test(handle);

const OUTPUT_LIMIT = 1024 * 1024;

export type DockerResult = { code: number; stdout: Buffer; stderr: string };
type RunOptions = { stdin?: Uint8Array; timeoutMs?: number; maxOutput?: number };
type RunDocker = (args: string[], options?: RunOptions) => Promise<DockerResult>;

/** Collects a stream, keeping only its last `max` bytes, and says how many were cut. */
function tail(max: number) {
  const chunks: Buffer[] = [];
  let kept = 0;
  let cut = 0;
  return {
    push(chunk: Buffer) {
      chunks.push(chunk);
      kept += chunk.length;
      while (kept > max) {
        const over = kept - max;
        const first = chunks[0];
        const drop = Math.min(first.length, over);
        if (drop === first.length) chunks.shift();
        else chunks[0] = first.subarray(drop);
        kept -= drop;
        cut += drop;
      }
    },
    bytes: () => Buffer.concat(cut ? [Buffer.from(`… (${cut} earlier bytes cut)\n`), ...chunks] : chunks),
  };
}

/** Runs the docker CLI with argv only (no shell), so paths and code never need quoting. */
export function runDocker(args: string[], { stdin, timeoutMs, maxOutput = Infinity }: RunOptions = {}): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { timeout: timeoutMs, killSignal: "SIGKILL" });
    const out = tail(maxOutput);
    const err = tail(maxOutput);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    // Code that exits before reading all of its stdin closes the pipe; the write error (EPIPE) is expected then.
    child.stdin.on("error", () => {});
    // A CLI killed by the host-side timeout has no exit code; 137 is the shell's status for a SIGKILL.
    child.on("close", (code) => resolve({ code: code ?? 137, stdout: out.bytes(), stderr: err.bytes().toString() }));
    child.stdin.end(stdin);
  });
}

// Matched only on output that docker, cat, sh and rm write, never on the output of the code being run; those tools'
// own lines start with their names, and paths can't hold a newline, so the line can't be faked through a file name.
const isGone = (stderr: string) => /^Error response from daemon: No such container/m.test(stderr);

/** Fails fast with a clear message when this machine can't run sandboxes, and creates the sandbox network once. */
export async function prepareDocker(run: RunDocker = runDocker): Promise<void> {
  const version = await run(["version", "--format", "{{.Server.Version}}"]).catch(() => undefined);
  if (!version) throw new Error("The docker CLI wasn't found. Install Docker Desktop.");
  if (version.code !== 0) throw new Error("Docker isn't running. Start Docker Desktop.");
  if ((await run(["image", "inspect", SANDBOX_IMAGE])).code !== 0) throw new Error("Build the sandbox image first: npm run sandbox:build");
  await ensureSandboxNetwork(run);
}

/**
 * The network for sessions with internet. With inter-container traffic off, one room's sandbox can't reach another's,
 * which the default bridge would allow.
 */
export async function ensureSandboxNetwork(run: RunDocker = runDocker): Promise<void> {
  if ((await run(["network", "inspect", SANDBOX_NETWORK])).code === 0) return;
  const created = await run([
    "network", "create", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false", "--label", LABEL, SANDBOX_NETWORK,
  ]);
  if (created.code !== 0 && !/already exists/.test(created.stderr)) throw new Error(`docker network create failed: ${created.stderr.trim()}`);
}

/** Removes sessions a previous server left behind; their runs can't reach them any more. Returns how many. */
export async function reapSandboxes(run: RunDocker = runDocker): Promise<number> {
  const ids = (await run(["ps", "-aq", "--filter", `label=${LABEL}`])).stdout.toString().split(/\s+/).filter(Boolean);
  if (ids.length) await run(["rm", "-f", ...ids]);
  return ids.length;
}

const INTERPRETERS: Record<Language, string[]> = { shell: ["sh", "-s"], python: ["python3", "-"], javascript: ["node", "-"] };

/**
 * Each session is a container that sleeps for the session lifetime. It gets no env, no mounts and no capabilities,
 * runs as an unprivileged user with CPU, memory and process limits, and has no network unless the room allows it.
 */
export function dockerSandbox(run: RunDocker = runDocker): Sandbox {
  async function ok(args: string[], stdin?: Uint8Array) {
    const result = await run(args, { stdin });
    if (result.code === 0) return result;
    if (isGone(result.stderr)) throw new SandboxGone(result.stderr.trim());
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  }

  /** Every call but start checks that the handle names a sandbox, so this API can't touch other containers. */
  async function inspect(handle: string): Promise<{ running: boolean }> {
    if (!isHandle(handle)) throw new Error(`${handle} is not a sandbox`);
    const { stdout } = await ok(["container", "inspect", "--format", '{{index .Config.Labels "cl-sandbox"}} {{.State.Running}}', handle]);
    const [label, running] = stdout.toString().trimEnd().split(" ");
    if (label !== "1") throw new Error(`${handle} is not a sandbox`);
    return { running: running === "true" };
  }
  async function running(handle: string) {
    if (!(await inspect(handle)).running) throw new SandboxGone(`${handle} is not running`);
  }

  return {
    async start({ runId, internet }) {
      // Pointing the host's names at loopback keeps casual calls off this machine's services (Floci, this server).
      // The gateway's raw IP still reaches them locally; closing that needs an egress proxy. On AWS, sessions run in
      // AgentCore instead.
      const network = internet
        ? ["--network", SANDBOX_NETWORK, "--add-host", "host.docker.internal:127.0.0.1", "--add-host", "gateway.docker.internal:127.0.0.1"]
        : ["--network", "none"];
      const { stdout } = await ok([
        "run", "-d", "--rm", "--label", LABEL, "--label", `cl-run=${runId}`, ...network,
        "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "256", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", "1000:1000", "-w", "/workspace", SANDBOX_IMAGE, "sleep", "7800",
      ]);
      return stdout.toString().trim();
    },

    async exec(handle, { language, code, timeoutSec }) {
      await running(handle);
      // `timeout` stops the code inside the container; the host-side kill only covers a docker CLI that hangs.
      const args = ["exec", "-i", handle, "timeout", "-k", "5", String(timeoutSec), ...INTERPRETERS[language]];
      const started = Date.now();
      const r = await run(args, { stdin: new TextEncoder().encode(code), timeoutMs: (timeoutSec + 15) * 1000, maxOutput: OUTPUT_LIMIT });
      // A SIGKILL (137) after the time limit is `timeout -k` or the host-side kill; before it, most likely the memory limit.
      const timedOut = r.code === 124 || (r.code === 137 && Date.now() - started >= timeoutSec * 1000);
      const stderr = r.code === 137 && !timedOut ? `${r.stderr}\nkilled (likely out of memory)` : r.stderr;
      return { stdout: r.stdout.toString(), stderr, exitCode: r.code, timedOut };
    },

    async writeFiles(handle, files) {
      await running(handle);
      for (const { path, bytes } of files) {
        await ok(["exec", "-i", handle, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], bytes);
      }
    },

    async readFiles(handle, paths) {
      await running(handle);
      const files = [];
      for (const path of paths) {
        const { stdout } = await ok(["exec", handle, "cat", "--", path]);
        files.push({ path, bytes: new Uint8Array(stdout) });
      }
      return files;
    },

    async removeFiles(handle, paths) {
      await running(handle);
      if (paths.length) await ok(["exec", handle, "rm", "-f", "--", ...paths]);
    },

    async stop(handle) {
      try {
        await inspect(handle);
        await ok(["rm", "-f", handle]);
      } catch (e) {
        if (!(e instanceof SandboxGone)) throw e;
      }
    },
  };
}
