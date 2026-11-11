/** The only key the fake accepts; fake mode sends it, so the key check runs too. */
export const FAKE_GEMINI_KEY = "fake";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Stands in for `fetch` in tests and local runs. It answers Gemini's image call the way Gemini does, so the real
 * request and parse code runs: a 1×1 PNG billed as one 1K image, a safety decline for any prompt that says "refuse",
 * and a 403 for a missing or wrong key.
 */
export const fakeGeminiFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  if (req.method !== "POST" || !req.url.startsWith("https://generativelanguage.googleapis.com/")) {
    return new Response("not found", { status: 404 });
  }
  if (req.headers.get("x-goog-api-key") !== FAKE_GEMINI_KEY) return Response.json({ error: { code: 403 } }, { status: 403 });
  const body = (await req.json()) as { contents: { parts: { text: string }[] }[] };
  const prompt = body.contents[0]?.parts[0]?.text ?? "";
  if (/\brefuse\b/.test(prompt)) {
    return Response.json({
      candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }],
      usageMetadata: { promptTokenCount: 10 },
    });
  }
  return Response.json({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: ONE_PIXEL_PNG } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }] },
  });
};
