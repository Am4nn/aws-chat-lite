import { createServer, type IncomingMessage, type Server } from "node:http";
import { fromWire, toWire } from "./remote.js";
import { SandboxGone, type Sandbox } from "./sandbox.js";

const BODY_LIMIT = 64 * 1024 * 1024;

type Body = Record<string, any>;

function routes(sandbox: Sandbox): Record<string, (b: Body) => Promise<unknown>> {
  return {
    start: async (b) => ({ handle: await sandbox.start({ runId: b.runId, internet: b.internet }) }),
    exec: (b) => sandbox.exec(b.handle, { language: b.language, code: b.code, timeoutSec: b.timeoutSec }),
    writeFiles: async (b) => { await sandbox.writeFiles(b.handle, fromWire(b.files)); return {}; },
    readFiles: async (b) => ({ files: toWire(await sandbox.readFiles(b.handle, b.paths)) }),
    removeFiles: async (b) => { await sandbox.removeFiles(b.handle, b.paths); return {}; },
    stop: async (b) => { await sandbox.stop(b.handle); return {}; },
  };
}

async function readBody(req: IncomingMessage): Promise<Body | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) return undefined;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

/**
 * The sandbox as an HTTP API on this machine, for Lambdas running in an emulator's containers, which can't drive
 * Docker themselves. `POST /<method>` takes the method's arguments as JSON, with file bytes as base64.
 */
export function startSandboxServer(sandbox: Sandbox, { port = 4700, host = "127.0.0.1" } = {}): Server {
  const handlers = routes(sandbox);
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const op = (req.url ?? "/").slice(1);
    if (req.method !== "POST" || !Object.hasOwn(handlers, op)) return reply(404, { error: "No such route." });
    try {
      const body = await readBody(req);
      if (!body) return reply(413, { error: "Body over 64 MB." });
      reply(200, await handlers[op](body));
    } catch (e) {
      if (e instanceof SandboxGone) return reply(410, { error: e.message });
      console.error("sandbox", op, "failed", e);
      reply(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  // Loopback by default: anyone who can reach this server can run code in a sandbox.
  return server.listen(port, host);
}
