import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { describe, expect, it } from "vitest";
import { audioFrame, endFrame, readFrame } from "./eventstream";

const codec = new EventStreamCodec(toUtf8, fromUtf8);
const frame = (headers: Record<string, string>, body: unknown) => codec.encode({
  headers: Object.fromEntries(Object.entries(headers).map(([k, value]) => [k, { type: "string", value }])),
  body: fromUtf8(JSON.stringify(body)),
});

describe("audioFrame", () => {
  it("wraps the audio in an AudioEvent message", () => {
    const { headers, body } = codec.decode(audioFrame(new Uint8Array([1, 2, 3])));
    expect(headers[":message-type"].value).toBe("event");
    expect(headers[":event-type"].value).toBe("AudioEvent");
    expect(headers[":content-type"].value).toBe("application/octet-stream");
    expect([...body]).toEqual([1, 2, 3]);
  });

  it("ends the stream with an empty one", () => {
    expect(codec.decode(endFrame()).body).toHaveLength(0);
  });
});

describe("readFrame", () => {
  it("reads the results of a transcript event", () => {
    const results = [{ IsPartial: true, Alternatives: [{ Transcript: "this" }] }];
    expect(readFrame(frame({ ":message-type": "event", ":event-type": "TranscriptEvent" }, { Transcript: { Results: results } })))
      .toEqual({ kind: "results", results });
  });

  it("reads an exception as an error with its message", () => {
    const bytes = frame({ ":message-type": "exception", ":exception-type": "BadRequestException" }, { Message: "Bad sample rate." });
    expect(readFrame(bytes)).toEqual({ kind: "error", message: "Bad sample rate." });
  });

  it("names the exception when it has no message", () => {
    const bytes = frame({ ":message-type": "exception", ":exception-type": "LimitExceededException" }, {});
    expect(readFrame(bytes)).toEqual({ kind: "error", message: "LimitExceededException" });
  });
});
