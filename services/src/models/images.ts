import type { Aspect } from "../threads/types.js";
import type { TokenUsage } from "./catalog.js";
import { FAKE_GEMINI_KEY, fakeGeminiFetch } from "./fake-gemini.js";
import { modelKeys } from "./keys.js";

export const IMAGE_MODEL = "gemini-3.1-flash-image";

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`;
const TIMEOUT_MS = 60_000;
const MAX_REPLY_CHARS = 8_000_000;
const NOT_AN_IMAGE = "Gemini sent back something that isn't an image.";
const BUSY = "Gemini is busy; try again in a minute.";
// Nano-dollars per token, from ai.google.dev on 2026-11-11 (Gemini has no free tier for this model).
const PRICE = { input: 500, text: 3000, image: 60_000 };
/** What one 1K image costs, charged when a reply doesn't say how many tokens it used. */
const UNMETERED_MICROS = 67_000;

type MediaType = "image/png" | "image/jpeg" | "image/webp";
type ImageRequest = { prompt: string; aspect: Aspect };
type ImageResult = ({ ok: true; bytes: Uint8Array; mediaType: MediaType } | { ok: false; error: string }) & {
  usage: TokenUsage;
  costMicros: number;
};
type UsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  candidatesTokensDetails?: { modality: string; tokenCount?: number }[];
};
type Part = { text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string } };
type Reply = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: UsageMetadata;
};

/** The types an answer may hold, each with its magic-number check, so a mislabelled reply is never stored as an image. */
const MAGIC = new Map<string, (b: Uint8Array) => boolean>([
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/webp", (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP"],
]);
const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

function tokens(meta: UsageMetadata) {
  const details = meta.candidatesTokensDetails ?? [];
  const image = details.filter((d) => d.modality === "IMAGE").reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
  const candidates = meta.candidatesTokenCount ?? details.reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
  return { prompt: meta.promptTokenCount ?? 0, text: candidates - image + (meta.thoughtsTokenCount ?? 0), image };
}

/** An image call's cost from Gemini's own token counts: image tokens are priced 20 times text tokens. */
export function geminiCostMicros(meta: UsageMetadata): number {
  const t = tokens(meta);
  return Math.ceil((t.prompt * PRICE.input + t.text * PRICE.text + t.image * PRICE.image) / 1000);
}

const usageOf = (meta?: UsageMetadata): TokenUsage => {
  const t = tokens(meta ?? {});
  return { inputTokens: t.prompt, outputTokens: t.text + t.image, cacheReadTokens: 0, cacheWriteTokens: 0 };
};
const failed = (error: string, meta?: UsageMetadata, costMicros = 0): ImageResult => ({
  ok: false,
  error,
  usage: usageOf(meta),
  costMicros,
});

function jsonOf(text: string): Reply | undefined {
  try {
    return JSON.parse(text) as Reply;
  } catch {
    return undefined;
  }
}

/** Reads Gemini's reply. Gemini bills every reply it sends, so a decline or a broken image still carries its cost. */
function parse(reply: Reply): ImageResult {
  const meta = reply.usageMetadata;
  const costMicros = meta ? geminiCostMicros(meta) : UNMETERED_MICROS;
  const candidate = reply.candidates?.[0];
  const declined = (reason: string) => failed(`Gemini declined to make that image (${reason}).`, meta, costMicros);
  if (reply.promptFeedback?.blockReason) return declined(reply.promptFeedback.blockReason);
  if (candidate?.finishReason !== "STOP") return declined(candidate?.finishReason ?? "NO_IMAGE");
  // A thinking model can send draft images marked as thoughts; only the final one is the answer.
  const image = candidate.content?.parts?.find((p) => p.inlineData && !p.thought)?.inlineData;
  if (!image) return declined("NO_IMAGE");
  const bytes = new Uint8Array(Buffer.from(image.data, "base64"));
  if (!MAGIC.get(image.mimeType)?.(bytes)) return failed(NOT_AN_IMAGE, meta, costMicros);
  return { ok: true, bytes, mediaType: image.mimeType as MediaType, usage: usageOf(meta), costMicros };
}

/**
 * Text to image on Gemini, through plain `fetch`. `fake` mode swaps in a fake `fetch`, so the request and parse code
 * is the same one that runs live. The key goes in a header, because a URL can end up in a log.
 */
export function imageModel(env: Record<string, string | undefined> = process.env, fetchFn?: typeof fetch) {
  const mode = env.MODEL_GATEWAY;
  if (mode !== "fake" && mode !== "live") throw new Error(`Unknown model gateway: ${mode}`);
  const send = fetchFn ?? (mode === "fake" ? fakeGeminiFetch : fetch);
  // The key is read on the first call, and a failed read isn't cached, because the model lives as long as its container.
  let key: Promise<string | undefined> | undefined;
  const keyOf = () =>
    (key ??= (mode === "fake" ? Promise.resolve(FAKE_GEMINI_KEY) : modelKeys(env).then((keys) => keys.geminiKey)).catch((e) => {
      key = undefined;
      throw e;
    }));

  return {
    async generate({ prompt, aspect }: ImageRequest): Promise<ImageResult> {
      const apiKey = await keyOf();
      if (!apiKey) return failed("Image generation isn't set up here (no GEMINI_API_KEY).");
      let res: Response;
      let text: string;
      try {
        res = await send(GEMINI_URL, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect, imageSize: "1K" } },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        text = await res.text();
      } catch {
        return failed(BUSY);
      }
      // Gemini's error bodies can quote the request, key included, so only the status is ever passed on.
      if (res.status === 401 || res.status === 403) return failed("Image generation isn't set up (Gemini refused the key).");
      if (res.status === 429 || res.status === 503) return failed(BUSY);
      if (!res.ok) return failed(`Gemini said ${res.status}.`);
      const reply = text.length > MAX_REPLY_CHARS ? undefined : jsonOf(text);
      return reply ? parse(reply) : failed(NOT_AN_IMAGE, undefined, UNMETERED_MICROS);
    },
  };
}
