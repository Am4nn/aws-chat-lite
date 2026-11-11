import { describe, expect, it } from "vitest";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { fakeSpeaker, pollySpeaker } from "./speaker.js";

describe("pollySpeaker", () => {
  it("asks Polly for Matthew's neural US English voice as 24 kHz MP3 of plain text", async () => {
    const sent: SynthesizeSpeechCommand[] = [];
    const client = {
      send: async (c: SynthesizeSpeechCommand) => {
        sent.push(c);
        return { AudioStream: { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) } };
      },
    } as unknown as PollyClient;
    expect(await pollySpeaker(client).synthesize("Hello there.")).toEqual(Uint8Array.from([1, 2, 3]));
    expect(sent[0]!.input).toEqual({
      Engine: "neural", VoiceId: "Matthew", LanguageCode: "en-US", OutputFormat: "mp3", SampleRate: "24000", TextType: "text", Text: "Hello there.",
    });
  });
});

describe("fakeSpeaker", () => {
  it("returns MPEG audio frames whatever the text", async () => {
    const audio = await fakeSpeaker().synthesize("anything");
    expect([audio[0], audio[1]! & 0xe0]).toEqual([0xff, 0xe0]);
    expect(audio).toEqual(await fakeSpeaker().synthesize("something else"));
  });
});
