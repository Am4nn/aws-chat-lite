import {
  BedrockAgentCoreClient, InvokeCodeInterpreterCommand, StartCodeInterpreterSessionCommand, StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { bySize } from "../lib/batches.js";
import { execOutcome, SandboxGone, type Language, type Sandbox } from "./sandbox.js";

const WRITE_BATCH_BYTES = 5 * 1024 * 1024;
// Linux refuses any one command argument over 128 KB (E2BIG); 64 KB of code is about 87 KB as base64.
const CODE_CHUNK_BYTES = 64 * 1024;
const RUNNERS: Record<Language, { ext: string; run: string }> = {
  shell: { ext: "sh", run: "sh" },
  python: { ext: "py", run: "python3" },
  javascript: { ext: "js", run: "node" },
};

type Handle = { interpreterId: string; sessionId: string };

/** Code Interpreter sessions of AgentCore; the handle "on:<id>" or "off:<id>" remembers which interpreter owns the session. */
export function agentCoreSandbox(o: { client: Pick<BedrockAgentCoreClient, "send">; offlineId: string; onlineId: string }): Sandbox {
  const parse = (handle: string): Handle => {
    const [mode, ...rest] = handle.split(":");
    return { interpreterId: mode === "on" ? o.onlineId : o.offlineId, sessionId: rest.join(":") };
  };

  // Every call on a vanished session must surface as SandboxGone so the run can open a new one.
  const gone = (e: unknown, h: Handle) => {
    const { name, message } = e as Error;
    return name === "ResourceNotFoundException" || (name === "ValidationException" && message.includes(h.sessionId));
  };

  async function invoke(handle: string, name: string, args: object) {
    const h = parse(handle);
    try {
      const res = await o.client.send(new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: h.interpreterId, sessionId: h.sessionId, name: name as never, arguments: args,
      }));
      const results = [];
      for await (const ev of res.stream ?? []) if (ev.result) results.push(ev.result);
      return results;
    } catch (e) {
      throw gone(e, h) ? new SandboxGone(`Session ${h.sessionId} is gone`) : e;
    }
  }

  async function command(handle: string, text: string) {
    const results = await invoke(handle, "executeCommand", { command: text });
    const structured = results.find((r) => r.structuredContent)?.structuredContent;
    return {
      exitCode: structured?.exitCode ?? (results.some((r) => r.isError) ? 1 : 0),
      stdout: structured ? (structured.stdout ?? "") : results.flatMap((r) => r.content ?? []).map((b) => b.text ?? "").join(""),
      stderr: structured?.stderr ?? "",
    };
  }

  return {
    async start({ runId, internet, lifetimeSec }) {
      const { sessionId } = await o.client.send(new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: internet ? o.onlineId : o.offlineId, name: `run-${runId}`, sessionTimeoutSeconds: lifetimeSec,
      }));
      return { handle: `${internet ? "on" : "off"}:${sessionId}`, internet };
    },

    async exec(handle, { language, code, timeoutSec }) {
      const { ext, run } = RUNNERS[language];
      const file = `/tmp/cl-run.${ext}`;
      // The code travels as base64 so no user text is ever quoted for the shell, in pieces small enough for one argument.
      const bytes = Buffer.from(code);
      const writes = [];
      for (let at = 0; at === 0 || at < bytes.length; at += CODE_CHUNK_BYTES) {
        writes.push(`printf %s ${bytes.subarray(at, at + CODE_CHUNK_BYTES).toString("base64")} | base64 -d ${at ? ">>" : ">"} ${file}`);
      }
      for (const write of writes.slice(0, -1)) {
        if ((await command(handle, write)).exitCode !== 0) throw new Error("The code couldn't be written into the sandbox.");
      }
      const started = Date.now();
      const r = await command(handle, `${writes.at(-1)} && timeout -k 5 ${timeoutSec} ${run} ${file}`);
      return { stdout: r.stdout, exitCode: r.exitCode, ...execOutcome(r.exitCode, r.stderr, Date.now() - started, timeoutSec) };
    },

    async writeFiles(handle, files) {
      for (const batch of bySize(files, (f) => f.bytes.length, WRITE_BATCH_BYTES)) {
        await invoke(handle, "writeFiles", { content: batch.map((f) => ({ path: f.path, blob: f.bytes })) });
      }
    },

    async readFiles(handle, paths) {
      const results = await invoke(handle, "readFiles", { paths });
      const files = [];
      for (const block of results.flatMap((r) => r.content ?? [])) {
        const { resource } = block;
        if (!resource?.uri) continue;
        // The service reports absolute URIs under its own working directory, so match them back to the requested paths.
        const uri = resource.uri.replace(/^file:\/\//, "");
        const path = paths.find((p) => uri === p || uri.endsWith(`/${p}`));
        if (path) files.push({ path, bytes: resource.blob ?? new TextEncoder().encode(resource.text ?? "") });
      }
      return files;
    },

    async stop(handle) {
      const h = parse(handle);
      await o.client.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: h.interpreterId, sessionId: h.sessionId }))
        .catch((e: Error) => { if (e.name !== "ResourceNotFoundException") throw e; });
    },
  };
}
