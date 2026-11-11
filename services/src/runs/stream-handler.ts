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
  const sink = {
    // The status and headers go out in the prelude, so they are fixed once the first byte is written.
    status: (statusCode: number) => { out = awslambda.HttpResponseStream.from(stream, { statusCode, headers: headersFor(statusCode) }); },
    write: (chunk: string) => { out.write(chunk); },
    end: () => { out.end(); },
  };
  const runId = runIdFromPath(event.rawPath);
  if (!runId) return refuse(sink, 404, "No such route.");
  // A client that hangs up closes the stream; stop polling then instead of at the stream's time limit.
  const gone = new AbortController();
  stream.on("close", () => gone.abort());
  await streamRun({
    runId, ticket: event.queryStringParameters?.ticket ?? "", lastEventId: event.headers["last-event-id"], signal: gone.signal,
  }, sink);
});
