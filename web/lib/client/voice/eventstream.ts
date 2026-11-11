import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";

/** Transcribe's WebSocket API carries one AWS event-stream message (binary headers + body + checksums) per frame. */
const codec = new EventStreamCodec(toUtf8, fromUtf8);

export type TranscribeResult = { IsPartial: boolean; Alternatives: { Transcript: string }[] };

export function audioFrame(pcm: Uint8Array): Uint8Array {
  return codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: "AudioEvent" },
      ":content-type": { type: "string", value: "application/octet-stream" },
    },
    body: pcm,
  });
}

/** An empty audio event tells Transcribe the speech is over, so it sends its last results and closes. */
export const endFrame = () => audioFrame(new Uint8Array(0));

export function readFrame(bytes: Uint8Array): { kind: "results"; results: TranscribeResult[] } | { kind: "error"; message: string } {
  const { headers, body } = codec.decode(bytes);
  const json = JSON.parse(toUtf8(body));
  if (headers[":message-type"]?.value === "exception") {
    return { kind: "error", message: json.Message ?? String(headers[":exception-type"]?.value) };
  }
  return { kind: "results", results: json.Transcript?.Results ?? [] };
}
