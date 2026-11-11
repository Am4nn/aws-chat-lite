import {
  BedrockAgentCoreClient, InvokeCodeInterpreterCommand, StartCodeInterpreterSessionCommand, StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { SandboxGone, type Language, type Sandbox, type WorkspaceFile } from "./sandbox.js";

const SESSION_SECONDS = 7800;
const WRITE_BATCH_BYTES = 5 * 1024 * 1024;
const TIMED_OUT_EXIT_CODES = [124, 137];
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

  return {
    async start({ runId, internet }) {
      const { sessionId } = await o.client.send(new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: internet ? o.onlineId : o.offlineId, name: `run-${runId}`, sessionTimeoutSeconds: SESSION_SECONDS,
      }));
      return `${internet ? "on" : "off"}:${sessionId}`;
    },

    async exec(handle, { language, code, timeoutSec }) {
      const { ext, run } = RUNNERS[language];
      const file = `/tmp/cl-run.${ext}`;
      // The code travels as base64 so no user text is ever quoted for the shell.
      const command = `printf %s ${Buffer.from(code).toString("base64")} | base64 -d > ${file} && timeout -k 5 ${timeoutSec} ${run} ${file}`;
      const results = await invoke(handle, "executeCommand", { command });
      const structured = results.find((r) => r.structuredContent)?.structuredContent;
      const exitCode = structured?.exitCode ?? (results.some((r) => r.isError) ? 1 : 0);
      const text = results.flatMap((r) => r.content ?? []).map((b) => b.text ?? "").join("");
      return {
        stdout: structured ? (structured.stdout ?? "") : text,
        stderr: structured?.stderr ?? "",
        exitCode,
        timedOut: TIMED_OUT_EXIT_CODES.includes(exitCode),
      };
    },

    async writeFiles(handle, files) {
      const batches: WorkspaceFile[][] = [];
      let size = 0;
      for (const f of files) {
        if (!batches.length || size + f.bytes.length > WRITE_BATCH_BYTES) {
          batches.push([]);
          size = 0;
        }
        batches.at(-1)!.push(f);
        size += f.bytes.length;
      }
      for (const batch of batches) await invoke(handle, "writeFiles", { content: batch.map((f) => ({ path: f.path, blob: f.bytes })) });
    },

    async readFiles(handle, paths) {
      const results = await invoke(handle, "readFiles", { paths });
      const files: WorkspaceFile[] = [];
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

    async removeFiles(handle, paths) {
      await invoke(handle, "removeFiles", { paths });
    },

    async stop(handle) {
      const h = parse(handle);
      await o.client.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: h.interpreterId, sessionId: h.sessionId }))
        .catch((e: Error) => { if (e.name !== "ResourceNotFoundException") throw e; });
    },
  };
}
