import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { WebSocket } from "ws";
import { startLocalTranscribeServer } from "./transcribe-local.js";

const codec = new EventStreamCodec(toUtf8, fromUtf8);
const header = (value: string) => ({ type: "string" as const, value });
const audioFrame = (pcm: Uint8Array) => codec.encode({
  headers: { ":message-type": header("event"), ":event-type": header("AudioEvent"), ":content-type": header("application/octet-stream") },
  body: pcm,
});

let server: ReturnType<typeof startLocalTranscribeServer> | undefined;
afterEach(() => server?.close());

type Frame = { headers: Record<string, string>; body: unknown };

/** Connects with `query`, sends `frames`, and resolves every frame the server sent before it closed, and the close code. */
async function session(query: string, frames: Uint8Array[]): Promise<{ frames: Frame[]; code: number }> {
  server = startLocalTranscribeServer(0);
  await new Promise((r) => server!.once("listening", r));
  const { port } = server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stream-transcription-websocket?${query}`);
  const got: Frame[] = [];
  ws.on("message", (data: Buffer) => {
    const { headers, body } = codec.decode(data);
    got.push({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v.value)])), body: JSON.parse(toUtf8(body)) });
  });
  ws.on("open", () => { for (const f of frames) ws.send(f); });
  const code = await new Promise<number>((r) => ws.on("close", r));
  return { frames: got, code };
}

const transcripts = (frames: Frame[]) =>
  frames.map((f) => (f.body as { Transcript: { Results: { IsPartial: boolean; Alternatives: { Transcript: string }[] }[] } }).Transcript.Results[0]!)
    .map((r) => ({ partial: r.IsPartial, text: r.Alternatives[0]!.Transcript }));

describe("the local Transcribe server", () => {
  it("answers each half second of audio with a growing partial, then the final text when the audio ends", async () => {
    const tenths = Array.from({ length: 10 }, () => audioFrame(new Uint8Array(3200)));
    const { frames, code } = await session("language-code=en-US&media-encoding=pcm&sample-rate=16000&session=s1", [...tenths, audioFrame(new Uint8Array(0))]);
    expect(frames.every((f) => f.headers[":message-type"] === "event" && f.headers[":event-type"] === "TranscriptEvent")).toBe(true);
    expect(transcripts(frames)).toEqual([
      { partial: true, text: "this" },
      { partial: true, text: "this is" },
      { partial: false, text: "this is" },
    ]);
    expect(code).toBe(1000);
  });

  it("refuses a socket without the sample rate with a BadRequestException frame, then closes", async () => {
    const { frames } = await session("language-code=en-US&media-encoding=pcm", []);
    expect(frames).toEqual([{
      headers: { ":message-type": "exception", ":exception-type": "BadRequestException", ":content-type": "application/json" },
      body: { Message: "sample-rate must be 16000." },
    }]);
  });

  it("refuses bytes that aren't an event-stream frame instead of crashing", async () => {
    const { frames } = await session("language-code=en-US&media-encoding=pcm&sample-rate=16000", [Uint8Array.from([1, 2, 3])]);
    expect(frames.map((f) => f.headers[":exception-type"])).toEqual(["BadRequestException"]);
  });
});
