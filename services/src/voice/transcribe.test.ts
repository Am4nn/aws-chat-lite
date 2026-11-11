import { afterEach, describe, expect, it } from "vitest";
import { transcribeUrl } from "./transcribe.js";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const now = new Date("2026-11-11T10:00:00Z");

afterEach(() => { delete process.env.TRANSCRIBE_LOCAL_URL; });

describe("transcribeUrl", () => {
  it("live: a SigV4-presigned Transcribe streaming socket for 16 kHz PCM in US English, valid 5 minutes", async () => {
    const url = new URL(await transcribeUrl("live", { sessionId: "s1", region: "ap-southeast-2", now, credentials }));
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("transcribestreaming.ap-southeast-2.amazonaws.com:8443");
    expect(url.pathname).toBe("/stream-transcription-websocket");
    const q = url.searchParams;
    expect([q.get("language-code"), q.get("media-encoding"), q.get("sample-rate")]).toEqual(["en-US", "pcm", "16000"]);
    expect(q.get("X-Amz-Expires")).toBe("300");
    expect(q.get("X-Amz-Credential")).toBe("AKIDEXAMPLE/20261111/ap-southeast-2/transcribe/aws4_request");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("live: the URL carries the access key id but never the secret key", async () => {
    const url = await transcribeUrl("live", { sessionId: "s1", region: "ap-southeast-2", now, credentials });
    expect(url).toContain("AKIDEXAMPLE");
    for (const form of [credentials.secretAccessKey, encodeURIComponent(credentials.secretAccessKey)]) expect(url).not.toContain(form);
  });

  it("fake: the local server, with the same query and the session id", async () => {
    process.env.TRANSCRIBE_LOCAL_URL = "ws://localhost:4601";
    expect(await transcribeUrl("fake", { sessionId: "s1", region: "ap-southeast-2", now })).toBe(
      "ws://localhost:4601/stream-transcription-websocket?language-code=en-US&media-encoding=pcm&sample-rate=16000&session=s1",
    );
  });
});
