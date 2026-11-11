import { describe, expect, it, vi } from "vitest";
import { geminiCostMicros, IMAGE_MODEL, imageModel } from "./images.js";

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`;
const KEY = "AIzaSyTestKey-not-real";
const live = { MODEL_GATEWAY: "live", GEMINI_API_KEY: KEY };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
const META = { promptTokenCount: 20, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }] };

const answering = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status }));
const imageReply = (inlineData: object, extra: object = {}) => ({
  candidates: [{ content: { parts: [{ text: "Here it is." }, { inlineData }] }, finishReason: "STOP" }],
  usageMetadata: META,
  ...extra,
});
const generate = (fetchFn: typeof fetch, prompt = "a red fox") =>
  imageModel(live, fetchFn).generate({ prompt, aspect: "16:9" });

describe("imageModel", () => {
  it("asks Gemini for one 1K image with the key in a header, never in the URL", async () => {
    const fetchFn = answering(imageReply({ mimeType: "image/png", data: PNG }));
    await generate(fetchFn);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GEMINI_URL);
    expect(url).not.toContain("key=");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "x-goog-api-key": KEY, "content-type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      contents: [{ role: "user", parts: [{ text: "a red fox" }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "1K" } },
    });
  });

  it("returns the image's bytes, its type, its tokens and its cost", async () => {
    const result = await generate(answering(imageReply({ mimeType: "image/png", data: PNG })));
    expect(result).toEqual({
      ok: true,
      bytes: new Uint8Array(Buffer.from(PNG, "base64")),
      mediaType: "image/png",
      usage: { inputTokens: 20, outputTokens: 1120, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costMicros: 67_210,
    });
  });

  it("refuses bytes that don't match their type's magic number", async () => {
    const html = Buffer.from("<html>").toString("base64");
    const result = await generate(answering(imageReply({ mimeType: "image/png", data: html })));
    expect(result).toMatchObject({ ok: false, error: "Gemini sent back something that isn't an image.", costMicros: 67_210 });
  });

  it("names Gemini's reason when it declines", async () => {
    const safety = { candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }], usageMetadata: { promptTokenCount: 20 } };
    expect(await generate(answering(safety))).toMatchObject({
      ok: false,
      error: "Gemini declined to make that image (IMAGE_SAFETY).",
      costMicros: 10,
    });
    expect(await generate(answering({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }))).toMatchObject({
      error: "Gemini declined to make that image (PROHIBITED_CONTENT).",
    });
  });

  it("bills a reply without token counts as one 1K image", async () => {
    const { usageMetadata: _, ...unmetered } = imageReply({ mimeType: "image/png", data: PNG });
    expect(await generate(answering(unmetered))).toMatchObject({ ok: true, costMicros: 67_000 });
  });

  it("maps Gemini's failures to plain words that cost nothing", async () => {
    expect(await generate(answering({}, 403))).toMatchObject({
      ok: false,
      error: "Image generation isn't set up (Gemini refused the key).",
      costMicros: 0,
    });
    expect(await generate(answering({}, 429))).toMatchObject({ error: "Gemini is busy; try again in a minute." });
    expect(await generate(vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")))).toMatchObject({
      error: "Gemini is busy; try again in a minute.",
    });
  });

  it("never repeats a key that Gemini's error echoes", async () => {
    const result = await generate(vi.fn(async () => new Response(`bad request for key ${KEY}`, { status: 500 })));
    expect(result).toMatchObject({ ok: false, error: "Gemini said 500." });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("AIza");
  });

  it("doesn't call Gemini without a key", async () => {
    const fetchFn = vi.fn();
    const result = await imageModel({ MODEL_GATEWAY: "live" }, fetchFn).generate({ prompt: "a fox", aspect: "1:1" });
    expect(result).toEqual({
      ok: false,
      error: "Image generation isn't set up here (no GEMINI_API_KEY).",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costMicros: 0,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("runs the real request and parse code against the fake in fake mode", async () => {
    const images = imageModel({ MODEL_GATEWAY: "fake" });
    expect(await images.generate({ prompt: "a fox", aspect: "1:1" })).toMatchObject({ ok: true, mediaType: "image/png", costMicros: 67_205 });
    expect(await images.generate({ prompt: "please refuse", aspect: "1:1" })).toMatchObject({
      ok: false,
      error: "Gemini declined to make that image (IMAGE_SAFETY).",
    });
  });
});

describe("geminiCostMicros", () => {
  it("prices prompt, thinking and image tokens at their own rates, rounded up", () => {
    expect(
      geminiCostMicros({ promptTokenCount: 20, thoughtsTokenCount: 100, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }] }),
    ).toBe(67_510);
    expect(geminiCostMicros({ promptTokenCount: 1 })).toBe(1);
  });

  it("prices candidate tokens that aren't image tokens as text", () => {
    expect(geminiCostMicros({ candidatesTokenCount: 1130, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }] })).toBe(67_230);
  });
});
