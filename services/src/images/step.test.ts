import { describe, expect, it } from "vitest";
import type { RunEvent } from "../threads/types.js";
import { QuotaError } from "../workspace/repo.js";
import { ROOM_FILES_BYTES } from "../workspace/limits.js";
import { generateImageStep, imagePath, type ImageDeps } from "./step.js";

const run = { runId: "RUN", roomId: "R", threadId: "T", number: 7 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const usage = { inputTokens: 10, outputTokens: 1120, cacheReadTokens: 0, cacheWriteTokens: 0 };
const cost = JSON.stringify({ usage, costMicros: 67_205 });
const SAVED = "Saved images/7-1-red-fox.png (1:1). It shows in the thread and in the room's files.";

/** Deps that record each call by name; `staged` is the staging object an earlier attempt left, if any. */
function fakeDeps(o: { staged?: boolean; made?: Awaited<ReturnType<ImageDeps["generate"]>>; usedBytes?: number; commit?: () => never } = {}) {
  const calls: string[] = [];
  const billed: number[] = [];
  const notified: unknown[] = [];
  const made = o.made ?? { ok: true as const, bytes: PNG, mediaType: "image/png" as const, usage, costMicros: 67_205 };
  const deps: ImageDeps = {
    generate: async () => (calls.push("generate"), made),
    files: {
      usage: async () => (calls.push("usage"), { bytes: o.usedBytes ?? 0, count: 1 }),
      commit: async (_roomId, c) => {
        calls.push("commit");
        if (o.commit) o.commit();
        return { file: { ...c, v: 1, updatedAt: "now", updatedBy: c.by } };
      },
    },
    storage: {
      findObject: async () => (calls.push("head"), o.staged ? { size: 4, contentType: "image/png", metadata: { cost } } : undefined),
      putBytes: async () => void calls.push("putBytes"),
      copyObject: async () => void calls.push("copy"),
      deleteObjects: async () => void calls.push("delete"),
    },
    bill: async (c) => {
      calls.push("bill");
      billed.push(c.costMicros);
    },
    notify: async (_roomId, event) => void notified.push(event),
  };
  return { deps, calls, billed, notified };
}

const at = (seq: number, body: object) => ({ seq, at: "now", ...body }) as RunEvent;
const imageUsage = at(4, { type: "usage", model: "gemini-3.1-flash-image", job: "image", step: 1, costMicros: 67_205, ...usage });
const input = { prompt: "Red fox in snow", name: "red fox" };

describe("imagePath", () => {
  it("names the file after the thread, the step and the first words of its name", () => {
    expect(imagePath(7, 1, "A red fox!", "image/png")).toBe("images/7-1-a-red-fox.png");
    expect(imagePath(7, 2, "one two three four five", "image/jpeg")).toBe("images/7-2-one-two-three-four.jpg");
    expect(imagePath(7, 3, "¿¡!", "image/webp")).toBe("images/7-3-image.webp");
    expect(imagePath(7, 4, "a".repeat(60), "image/png")).toBe(`images/7-4-${"a".repeat(40)}.png`);
  });
});

describe("generateImageStep", () => {
  it("a fresh step generates, stages, bills, then saves the image as a room file and tells the room", async () => {
    const { deps, calls, billed, notified } = fakeDeps();
    const result = await generateImageStep(run, 1, input, [], deps);
    expect(calls).toEqual(["head", "usage", "generate", "putBytes", "bill", "copy", "commit"]);
    expect(billed).toEqual([67_205]);
    expect(result).toEqual({
      ok: true, output: SAVED, image: { path: "images/7-1-red-fox.png", aspect: "1:1" },
      synced: { written: ["images/7-1-red-fox.png"], deleted: [], notes: [] },
    });
    expect(notified).toMatchObject([{ type: "files.updated", roomId: "R", files: [{ path: "images/7-1-red-fox.png" }], deleted: [] }]);
  });

  it("a retry that finds the staged image but no charge bills it once, without asking Gemini again", async () => {
    const { deps, calls, billed } = fakeDeps({ staged: true });
    expect((await generateImageStep(run, 1, input, [], deps)).output).toBe(SAVED);
    expect(calls).not.toContain("generate");
    expect(billed).toEqual([67_205]);
  });

  it("a retry that finds the image already billed neither asks Gemini nor bills again", async () => {
    const { deps, calls } = fakeDeps({ staged: true });
    expect((await generateImageStep(run, 1, input, [imageUsage], deps)).ok).toBe(true);
    expect(calls).not.toContain("generate");
    expect(calls).not.toContain("bill");
  });

  it("a retry that finds the file already saved only finishes", async () => {
    const { deps, calls } = fakeDeps({ staged: true });
    const synced = at(5, { type: "files.synced", step: 1, written: ["images/7-1-red-fox.png"], deleted: [], notes: [] });
    expect((await generateImageStep(run, 1, input, [imageUsage, synced], deps)).output).toBe(SAVED);
    expect(calls).toEqual([]);
  });

  it("a decline is billed what Gemini charged, and nothing is saved", async () => {
    const made = { ok: false as const, error: "Gemini declined to make that image (IMAGE_SAFETY).", usage, costMicros: 5 };
    const { deps, calls, billed } = fakeDeps({ made });
    expect(await generateImageStep(run, 1, input, [], deps)).toEqual({ ok: false, output: made.error });
    expect(billed).toEqual([5]);
    expect(calls).not.toContain("commit");
  });

  it("a retry after a charged failure doesn't ask Gemini again", async () => {
    const { deps, calls } = fakeDeps();
    expect(await generateImageStep(run, 1, input, [imageUsage], deps)).toEqual({ ok: false, output: "Gemini didn't make that image." });
    expect(calls).toEqual(["head"]);
  });

  it("a failure Gemini didn't charge for bills nothing", async () => {
    const { deps, billed } = fakeDeps({ made: { ok: false, error: "Gemini is busy; try again in a minute.", usage, costMicros: 0 } });
    expect((await generateImageStep(run, 1, input, [], deps)).ok).toBe(false);
    expect(billed).toEqual([]);
  });

  it("a room without space for another image is told so before Gemini is asked", async () => {
    const { deps, calls } = fakeDeps({ usedBytes: ROOM_FILES_BYTES - 1000 });
    expect(await generateImageStep(run, 1, input, [], deps)).toEqual({
      ok: false, output: "The room's files are full, so the image has nowhere to go.",
    });
    expect(calls).not.toContain("generate");
  });

  it("a room that filled up while the image was made drops the copy and says so", async () => {
    const { deps, calls } = fakeDeps({ commit: () => { throw new QuotaError("full"); } });
    expect((await generateImageStep(run, 1, input, [], deps)).output).toBe("The room's files are full, so the image has nowhere to go.");
    expect(calls.at(-1)).toBe("delete");
  });

  it("refuses an empty or overlong prompt before anything else", async () => {
    for (const prompt of ["", "  ", "x".repeat(2001), 42]) {
      const { deps, calls } = fakeDeps();
      expect(await generateImageStep(run, 1, { prompt }, [], deps)).toEqual({ ok: false, output: "Describe the image in 1 to 2000 characters." });
      expect(calls).toEqual([]);
    }
  });

  it("keeps a valid aspect and names the file after the prompt when there's no name", async () => {
    const { deps } = fakeDeps();
    const result = await generateImageStep(run, 2, { prompt: "Night sky over hills", aspect: "16:9" }, [], deps);
    expect(result.image).toEqual({ path: "images/7-2-night-sky-over-hills.png", aspect: "16:9" });
  });
});
