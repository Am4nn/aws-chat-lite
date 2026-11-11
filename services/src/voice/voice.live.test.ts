import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { describe, expect, it } from "vitest";
import { pollySpeaker } from "./speaker.js";
import { SAMPLE_RATE, transcribeUrl } from "./transcribe.js";

// Polly and Transcribe have no local stand-in that proves the real protocol, so this suite runs on AWS, with real
// credentials that may call both: REAL_AWS=1 npm -w services run test:live -- voice. It costs well under a cent.
const region = process.env.AWS_REGION ?? "ap-southeast-2";
const codec = new EventStreamCodec(toUtf8, fromUtf8);
const audioEvent = (pcm: Uint8Array) => codec.encode({
  headers: {
    ":message-type": { type: "string", value: "event" },
    ":event-type": { type: "string", value: "AudioEvent" },
    ":content-type": { type: "string", value: "application/octet-stream" },
  },
  body: pcm,
});

/** Two seconds of 16 kHz, 16-bit mono speech: Polly reads the line as raw PCM, padded with silence. */
async function twoSecondsOfSpeech(): Promise<Uint8Array> {
  const { AudioStream } = await new PollyClient({ region }).send(new SynthesizeSpeechCommand({
    Engine: "neural", VoiceId: "Matthew", OutputFormat: "pcm", SampleRate: String(SAMPLE_RATE), Text: "Hello from chat lite.",
  }));
  const speech = await AudioStream!.transformToByteArray();
  const audio = new Uint8Array(Math.max(speech.length, SAMPLE_RATE * 2 * 2));
  audio.set(speech);
  return audio;
}

/** Streams the audio in 100 ms frames at real-time pace, ends it, and resolves with the final transcripts. */
function transcribe(url: string, audio: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const finals: string[] = [];
    ws.onerror = () => reject(new Error("the Transcribe socket failed"));
    ws.onclose = () => resolve(finals.join(" "));
    ws.onmessage = (m) => {
      const { headers, body } = codec.decode(new Uint8Array(m.data as ArrayBuffer));
      const json = JSON.parse(toUtf8(body));
      if (headers[":message-type"]?.value === "exception") return reject(new Error(json.Message));
      for (const r of json.Transcript?.Results ?? []) if (!r.IsPartial) finals.push(r.Alternatives[0]?.Transcript ?? "");
    };
    ws.onopen = async () => {
      const frame = SAMPLE_RATE * 2 / 10;
      for (let at = 0; at < audio.length; at += frame) {
        ws.send(audioEvent(audio.subarray(at, at + frame)));
        await new Promise((r) => setTimeout(r, 100));
      }
      ws.send(audioEvent(new Uint8Array(0)));
    };
  });
}

describe.skipIf(!process.env.REAL_AWS)("voice on AWS", () => {
  it("Polly reads a line as MP3", async () => {
    const mp3 = await pollySpeaker(new PollyClient({ region })).synthesize("Hello from chat-lite.");
    // An MP3 starts with an ID3 tag or a frame sync (11 set bits).
    const id3 = toUtf8(mp3.subarray(0, 3)) === "ID3";
    expect(id3 || (mp3[0] === 0xff && (mp3[1]! & 0xe0) === 0xe0)).toBe(true);
    expect(mp3.length).toBeGreaterThan(1000);
  });

  it("Transcribe hears two seconds of speech through a presigned URL", async () => {
    const url = await transcribeUrl("live", { sessionId: crypto.randomUUID(), region, now: new Date() });
    const heard = await transcribe(url, await twoSecondsOfSpeech());
    console.log(`Transcribe heard: "${heard}"`);
    expect(heard.trim()).not.toBe("");
  });
});
