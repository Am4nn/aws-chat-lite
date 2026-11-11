import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

/** Text to MP3 audio. */
export type Speaker = { synthesize(text: string): Promise<Uint8Array> };

export function pollySpeaker(client = new PollyClient({})): Speaker {
  return {
    async synthesize(Text) {
      const { AudioStream } = await client.send(new SynthesizeSpeechCommand({
        Engine: "neural", VoiceId: "Matthew", LanguageCode: "en-US", OutputFormat: "mp3", SampleRate: "24000", TextType: "text", Text,
      }));
      return AudioStream!.transformToByteArray();
    },
  };
}

/**
 * One second of silence, as Polly's own format: MPEG-2 Layer III frames at 24 kHz, 32 kbit/s, mono. A frame is 96
 * bytes and holds 576 samples; a header followed by zeros decodes to silence.
 */
const SILENCE = (() => {
  const frame = new Uint8Array(96);
  frame.set([0xff, 0xf3, 0x44, 0xc0]);
  const frames = Math.ceil(24_000 / 576);
  const audio = new Uint8Array(frame.length * frames);
  for (let i = 0; i < frames; i++) audio.set(frame, i * frame.length);
  return audio;
})();

/** Plays a second of silence, so the read-aloud path runs end to end without calling Polly. */
export function fakeSpeaker(): Speaker {
  return { synthesize: async () => SILENCE };
}

export const speaker = (mode = process.env.VOICE_MODE): Speaker => (mode === "live" ? pollySpeaker() : fakeSpeaker());
