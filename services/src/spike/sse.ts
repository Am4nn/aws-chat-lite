import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** Provided by the Lambda Node.js runtime for response streaming. */
declare const awslambda: {
  streamifyResponse: (fn: (event: any, stream: NodeJS.WritableStream) => Promise<void>) => unknown;
  HttpResponseStream: { from: (stream: NodeJS.WritableStream, meta: { statusCode: number; headers: Record<string, string> }) => NodeJS.WritableStream };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOTAL_EVENTS = 5;

/** SSE frame: the id lets a reconnecting client say where it stopped (Last-Event-ID). */
const sseFrame = (n: number) => `id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`;

/** Events 1..TOTAL_EVENTS still to send after `lastEventId`, so a reconnect resumes instead of starting over. */
function remaining(lastEventId: string | undefined): number[] {
  const from = Math.max(0, Number.parseInt(lastEventId ?? "0", 10) || 0);
  return Array.from({ length: TOTAL_EVENTS }, (_, i) => i + 1).filter((n) => n > from);
}

export const handler = awslambda.streamifyResponse(async (event: APIGatewayProxyEventV2, stream) => {
  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
  for (const n of remaining(event.headers?.["last-event-id"])) {
    out.write(sseFrame(n));
    await sleep(300);
  }
  out.end();
});
