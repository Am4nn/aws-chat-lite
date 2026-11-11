import { spawn } from "node:child_process";
import { SandboxGone, type Language, type Sandbox } from "./sandbox.js";

export const SANDBOX_IMAGE = "cl-sandbox:1";

type DockerResult = { code: number; stdout: Buffer; stderr: string };

/** Runs the docker CLI with argv only (no shell), so paths and code never need quoting. */
export function runDocker(args: string[], stdin?: Uint8Array, timeoutMs?: number): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { timeout: timeoutMs, killSignal: "SIGKILL" });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    // A CLI killed by the host-side timeout has no exit code; 137 is the shell's status for a SIGKILL.
    child.on("close", (code) => resolve({ code: code ?? 137, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(stdin);
  });
}

const INTERPRETERS: Record<Language, string[]> = { shell: ["sh", "-s"], python: ["python3", "-"], javascript: ["node", "-"] };

// Only the daemon's own error lines count, so code that prints "is not running" doesn't end its session.
const isGone = (stderr: string) => /^Error response from daemon: (No such container|container \S+ is not running)/m.test(stderr);

/**
 * Each session is a container that sleeps for the session lifetime. It gets no env, no mounts and no capabilities,
 * runs as an unprivileged user with CPU, memory and process limits, and has no network unless the room allows it.
 */
export function dockerSandbox(run = runDocker): Sandbox {
  async function docker(args: string[], stdin?: Uint8Array, timeoutMs?: number) {
    const result = await run(args, stdin, timeoutMs);
    if (result.code !== 0 && isGone(result.stderr)) throw new SandboxGone(result.stderr.trim());
    return result;
  }
  async function ok(args: string[], stdin?: Uint8Array) {
    const result = await docker(args, stdin);
    if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
    return result;
  }

  return {
    async start({ runId, internet }) {
      const { stdout } = await ok([
        "run", "-d", "--rm", "--label", "cl-sandbox=1", "--label", `cl-run=${runId}`, "--network", internet ? "bridge" : "none",
        "--memory", "1g", "--cpus", "1", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", "1000:1000", "-w", "/workspace", SANDBOX_IMAGE, "sleep", "7800",
      ]);
      return stdout.toString().trim();
    },

    async exec(handle, { language, code, timeoutSec }) {
      // `timeout` stops the code inside the container; the host-side kill only covers a docker CLI that hangs.
      const args = ["exec", "-i", handle, "timeout", "-k", "5", String(timeoutSec), ...INTERPRETERS[language]];
      const r = await docker(args, new TextEncoder().encode(code), (timeoutSec + 15) * 1000);
      return { stdout: r.stdout.toString(), stderr: r.stderr, exitCode: r.code, timedOut: r.code === 124 || r.code === 137 };
    },

    async writeFiles(handle, files) {
      for (const { path, bytes } of files) {
        await ok(["exec", "-i", handle, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], bytes);
      }
    },

    async readFiles(handle, paths) {
      const files = [];
      for (const path of paths) {
        const { stdout } = await ok(["exec", handle, "cat", "--", path]);
        files.push({ path, bytes: new Uint8Array(stdout) });
      }
      return files;
    },

    async removeFiles(handle, paths) {
      if (paths.length) await ok(["exec", handle, "rm", "-f", "--", ...paths]);
    },

    async stop(handle) {
      try {
        await ok(["rm", "-f", handle]);
      } catch (e) {
        if (!(e instanceof SandboxGone)) throw e;
      }
    },
  };
}
