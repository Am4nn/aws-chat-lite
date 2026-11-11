import { createServer, type Server } from "node:http";
import { STREAM_HEADERS, runIdFromPath, streamRun } from "./stream.js";

/** The same CORS the Function URL is given: any origin, since the ticket is the auth and no cookies travel. */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-allow-headers": "last-event-id" };

/**
 * The run stream as a plain Node HTTP server, for emulators whose Function URLs can't stream a response body. It
 * serves the same `streamRun` as the Lambda, so only the transport differs.
 */
export function startStreamServer(port = 4600): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }
    const runId = req.method === "GET" ? runIdFromPath(url.pathname) : undefined;
    if (!runId) {
      res.writeHead(404, CORS).end();
      return;
    }
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const sink = {
      status: (code: number) => { res.writeHead(code, { ...STREAM_HEADERS, ...CORS }).flushHeaders(); },
      write: (chunk: string) => { res.write(chunk); },
      end: () => { res.end(); },
    };
    const lastEventId = req.headers["last-event-id"];
    try {
      await streamRun({
        runId, ticket: url.searchParams.get("ticket") ?? "", lastEventId: typeof lastEventId === "string" ? lastEventId : undefined,
        signal: gone.signal,
      }, sink);
    } catch (e) {
      console.error("run stream failed", runId, e);
      if (!res.headersSent) res.writeHead(500, CORS);
      res.end();
    }
  });
  return server.listen(port);
}
