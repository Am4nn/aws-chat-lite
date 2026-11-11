import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { imageType } from "./image-header.js";
import { imageModel } from "./images.js";

// One real Gemini image costs about $0.07, so this is one call, run on purpose:
// REAL_MODELS=1 npm -w services run test:live -- images
describe.skipIf(!process.env.REAL_MODELS)("Gemini image, live", () => {
  it("draws a 1K image and says what it cost", async () => {
    const gemini = imageModel({ ...process.env, MODEL_GATEWAY: "live" });
    const made = await gemini.generate({ prompt: "a small lime-green paper boat on dark water, flat illustration", aspect: "1:1" });
    expect(made).toMatchObject({ ok: true });
    if (!made.ok) return;
    expect(["image/png", "image/jpeg"]).toContain(imageType(made.bytes));
    expect(made.costMicros).toBeGreaterThanOrEqual(40_000);
    expect(made.costMicros).toBeLessThanOrEqual(160_000);
    const file = join(tmpdir(), `gemini-boat.${made.mediaType === "image/png" ? "png" : "jpg"}`);
    writeFileSync(file, made.bytes);
    console.log(`${file} · ${made.costMicros} µ$ · ${JSON.stringify(made.usage)}`);
  });
});
