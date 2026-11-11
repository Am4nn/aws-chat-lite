import type { LambdaFunctionURLEvent } from "aws-lambda";
import { headersFor, refuse, runIdFromPath, streamRun } from "./stream.js";

/** Provided by the Lambda Node.js runtime for response streaming. */
declare const awslambda: {
  streamifyResponse: (fn: (event: any, stream: NodeJS.WritableStream) => Promise<void>) => unknown;
  HttpResponseStream: { from: (stream: NodeJS.WritableStream, meta: { statusCode: number; headers: Record<string, string> }) => NodeJS.WritableStream };
};

/** A run's event stream behind a RESPONSE_STREAM Function URL: `GET /runs/<runId>/stream?ticket=<t>`. */
export const handler = awslambda.streamifyResponse(async (event: LambdaFunctionURLEvent, stream) => {
  let out: NodeJS.WritableStream = stream;
  let opened = false;
  const sink = {
    // The status and headers go out in the prelude, so they are fixed once the first byte is written.
    status: (statusCode: number) => {
      opened = true;
      out = awslambda.HttpResponseStream.from(stream, { statusCode, headers: headersFor(statusCode) });
    },
    write: (chunk: string) => { out.write(chunk); },
    end: () => { out.end(); },
  };
  const runId = runIdFromPath(event.rawPath);
  if (!runId) return refuse(sink, 404, "No such route.");
  // A client that hangs up closes the stream; stop polling then instead of at the stream's time limit.
  const gone = new AbortController();
  stream.on("close", () => gone.abort());
  try {
    await streamRun({
      runId, ticket: event.queryStringParameters?.ticket ?? "", lastEventId: event.headers["last-event-id"], signal: gone.signal,
    }, sink);
  } catch (e) {
    console.error("run stream failed", runId, e);
    // A stream whose prelude is out can't change its status any more, so it just ends.
    if (opened) sink.end();
    else refuse(sink, 500, "The stream failed.");
  }
});
