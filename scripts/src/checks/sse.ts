import { LambdaClient, InvokeWithResponseStreamCommand } from "@aws-sdk/client-lambda";
import { check, withTimeout, assert, flociHost, type Outputs, type Stage } from "./util.js";

export interface SseEvent { id: string; event: string; data: string }

/** Complete SSE frames (blank-line terminated) in `text`; a trailing partial frame is ignored. */
export function parseSse(text: string): SseEvent[] {
  const frames = text.replace(/\r\n/g, "\n").split("\n\n");
  frames.pop(); // after the last "\n\n": empty or a partial frame
  return frames.filter((f) => f.trim()).map((f) => {
    const ev: SseEvent = { id: "", event: "message", data: "" };
    for (const line of f.split("\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const key = line.slice(0, i);
      const value = line.slice(i + 1).replace(/^ /, "");
      if (key === "id") ev.id = value;
      else if (key === "event") ev.event = value;
      else if (key === "data") ev.data = ev.data ? `${ev.data}\n${value}` : value;
    }
    return ev;
  });
}

/** Streamed when the first bytes arrive well before the end; buffered when they arrive all at once. */
export function classifyStream(firstChunkMs: number, totalMs: number): "streamed" | "buffered" {
  return firstChunkMs < totalMs * 0.5 ? "streamed" : "buffered";
}

interface Read { text: string; firstChunkMs: number; totalMs: number; via: string }

async function readUrl(url: string, lastEventId?: string): Promise<Read> {
  const t0 = Date.now();
  const res = await fetch(url, { headers: lastEventId ? { "last-event-id": lastEventId } : {} });
  if (!res.ok || !res.body) throw new Error(`GET ${url} → ${res.status}`);
  let text = "";
  let firstChunkMs = -1;
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    if (firstChunkMs < 0) firstChunkMs = Date.now() - t0;
    text += dec.decode(chunk, { stream: true });
  }
  return { text, firstChunkMs, totalMs: Date.now() - t0, via: "Function URL" };
}

async function readInvoke(fnName: string, lastEventId?: string): Promise<Read> {
  const t0 = Date.now();
  const event = { headers: lastEventId ? { "last-event-id": lastEventId } : {} };
  const res = await new LambdaClient({}).send(new InvokeWithResponseStreamCommand({
    FunctionName: fnName, Payload: Buffer.from(JSON.stringify(event)),
  }));
  let raw = "";
  let firstChunkMs = -1;
  const dec = new TextDecoder();
  for await (const e of res.EventStream ?? []) {
    if (e.PayloadChunk?.Payload) {
      if (firstChunkMs < 0) firstChunkMs = Date.now() - t0;
      raw += dec.decode(e.PayloadChunk.Payload, { stream: true });
    }
    if (e.InvokeComplete?.ErrorCode) throw new Error(`stream error ${e.InvokeComplete.ErrorCode}: ${e.InvokeComplete.ErrorDetails}`);
  }
  // HttpResponseStream prefixes a JSON prelude + 8 null bytes before the body.
  const text = raw.includes("\0\0\0\0\0\0\0\0") ? raw.slice(raw.indexOf("\0\0\0\0\0\0\0\0") + 8) : raw;
  return { text, firstChunkMs, totalMs: Date.now() - t0, via: "InvokeWithResponseStream" };
}

export async function run(o: Outputs, stage: Stage) {
  const url = stage === "local" ? `http://${flociHost(o.SseUrl)}/` : o.SseUrl;
  let via = "";
  const read = async (last?: string): Promise<Read> => {
    try {
      const r = await readUrl(url, last);
      via = r.via;
      return r;
    } catch (e) {
      if (stage === "aws") throw e;
      const r = await readInvoke(o.SseFnName, last); // Floci may not serve streaming Function URLs
      via = `${r.via} (Function URL failed: ${(e as Error).message})`;
      return r;
    }
  };
  return [
    await check("Lambda streaming (SSE)", "5 events arrive as they are written, not all at the end", async () => {
      const r = await withTimeout(read(), 30_000, "SSE stream");
      const ids = parseSse(r.text).map((e) => e.id);
      assert(ids.join(",") === "1,2,3,4,5", `got event ids [${ids}] from ${JSON.stringify(r.text.slice(0, 120))}`);
      const kind = classifyStream(r.firstChunkMs, r.totalMs);
      assert(kind === "streamed", `buffered, not streamed: first chunk at ${r.firstChunkMs} ms of ${r.totalMs} ms (via ${via})`);
      return `streamed via ${via}: first event ${r.firstChunkMs} ms, all 5 by ${r.totalMs} ms`;
    }),
    await check("Lambda streaming (SSE)", "resume with Last-Event-ID: 3 → only events 4, 5", async () => {
      const r = await withTimeout(read("3"), 30_000, "SSE resume");
      const ids = parseSse(r.text).map((e) => e.id);
      assert(ids.join(",") === "4,5", `got [${ids}]`);
      return `via ${via}`;
    }),
  ];
}
