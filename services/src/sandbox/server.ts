import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isHandle } from "./docker.js";
import { BODY_LIMIT, fromWire, toWire } from "./remote.js";
import { LANGUAGES, MAX_TIMEOUT_SEC, SandboxGone, type Sandbox } from "./sandbox.js";

type Body = Record<string, any>;
type Route = { valid: (b: Body) => boolean; run: (b: Body) => Promise<unknown> };

const isText = (v: unknown): v is string => typeof v === "string";
const isTexts = (v: unknown) => Array.isArray(v) && v.every(isText);
const isCount = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
// A day is far past any run; the cap only stops a caller from keeping containers forever.
const MAX_LIFETIME_SEC = 86_400;

function routes(sandbox: Sandbox): Record<string, Route> {
  return {
    start: {
      valid: (b) => isText(b.runId) && b.runId.length > 0 && typeof b.internet === "boolean" && isCount(b.lifetimeSec, MAX_LIFETIME_SEC),
      run: (b) => sandbox.start({ runId: b.runId, internet: b.internet === true, lifetimeSec: b.lifetimeSec }),
    },
    exec: {
      valid: (b) => isHandle(b.handle) && LANGUAGES.includes(b.language) && isText(b.code) && isCount(b.timeoutSec, MAX_TIMEOUT_SEC),
      run: (b) => sandbox.exec(b.handle, { language: b.language, code: b.code, timeoutSec: b.timeoutSec }),
    },
    writeFiles: {
      valid: (b) => isHandle(b.handle) && Array.isArray(b.files) && b.files.every((f: any) => isText(f?.path) && isText(f?.bytes)),
      run: async (b) => { await sandbox.writeFiles(b.handle, fromWire(b.files)); return {}; },
    },
    readFiles: {
      valid: (b) => isHandle(b.handle) && isTexts(b.paths),
      run: async (b) => ({ files: toWire(await sandbox.readFiles(b.handle, b.paths)) }),
    },
    stop: {
      valid: (b) => isHandle(b.handle),
      run: async (b) => { await sandbox.stop(b.handle); return {}; },
    },
  };
}

/** The raw body, or undefined once it passes the limit (a chunked body has no content-length to check first). */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function parse(text: string): Body | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Body;
  } catch {
    // Not JSON, which reads as no body.
  }
  return undefined;
}

// Hashing first gives both sides the same length, which timingSafeEqual needs, without leaking the token's length.
const digest = (text: string) => createHash("sha256").update(text).digest();

/**
 * The sandbox as an HTTP API on this machine, for Lambdas running in an emulator's containers, which can't drive
 * Docker themselves. `POST /<method>` takes the method's arguments as JSON, with file bytes as base64.
 *
 * Anyone who reaches it can run code, so it listens on loopback only, takes only the shared token, and takes only
 * its own Host names and a JSON content type, which a web page can't send to it without the browser asking first.
 */
export function startSandboxServer(sandbox: Sandbox, { token, port = 4700, host = "127.0.0.1" }: { token: string; port?: number; host?: string }): Server {
  if (!token) throw new Error("The sandbox server needs a token (SANDBOX_TOKEN).");
  const expected = digest(token);
  const handlers = routes(sandbox);
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown, headers = {}) =>
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    const op = (req.url ?? "/").slice(1);
    const route = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
    if (req.method !== "POST" || !route) return reply(404, { error: "No such route." });
    const bound = (server.address() as AddressInfo).port;
    if (![`127.0.0.1:${bound}`, `host.docker.internal:${bound}`].includes(req.headers.host ?? "")) return reply(403, { error: "Wrong host." });
    if (!timingSafeEqual(digest(String(req.headers["x-sandbox-token"] ?? "")), expected)) return reply(401, { error: "Wrong token." });
    if (!req.headers["content-type"]?.startsWith("application/json")) return reply(415, { error: "Send JSON." });
    const tooBig = () => reply(413, { error: "Body over 64 MB." }, { connection: "close" });
    if (Number(req.headers["content-length"]) > BODY_LIMIT) return tooBig();
    try {
      const text = await readBody(req);
      if (text === undefined) return tooBig();
      const body = parse(text);
      if (!body || !route.valid(body)) return reply(400, { error: `Bad arguments for ${op}.` });
      reply(200, await route.run(body));
    } catch (e) {
      if (e instanceof SandboxGone) return reply(410, { error: e.message });
      console.error("sandbox", op, "failed", e);
      reply(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  return server.listen(port, host);
}
