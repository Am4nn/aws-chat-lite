import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ImagePart, ModelMessage } from "./gateway.js";
import { loadImages } from "./vision.js";

const SONNET = "claude-sonnet-5-5";
// The cache outlives a test, so each test's images get keys of their own.
const part = (size = 10): ImagePart => ({ name: "a.png", mediaType: "image/png", key: `k/${randomUUID()}`, size });
const said = (...images: ImagePart[]): ModelMessage => ({ role: "user", author: "aman", text: "see", images });

function recorder() {
  const reads: string[] = [];
  const read = async (key: string) => {
    reads.push(key);
    return new TextEncoder().encode(key);
  };
  return { reads, read };
}
const loaded = (messages: ModelMessage[]) =>
  messages.flatMap((m) => (m.role === "user" ? m.images ?? [] : [])).map((p) => p.data !== undefined);

describe("loadImages", () => {
  it("fills in the bytes of the newest 20 images, as base64", async () => {
    const { reads, read } = recorder();
    const images = Array.from({ length: 25 }, () => part());
    const messages = [said(...images.slice(0, 15)), { role: "assistant", text: "ok" } as const, said(...images.slice(15))];
    const out = await loadImages(messages, SONNET, read);
    expect(loaded(out)).toEqual([...Array(5).fill(false), ...Array(20).fill(true)]);
    expect(reads).toHaveLength(20);
    const last = images.at(-1)!;
    expect(out.flatMap((m) => (m.role === "user" ? m.images ?? [] : [])).at(-1)).toEqual({
      ...last, data: Buffer.from(last.key).toString("base64"),
    });
    expect(messages[0]).toEqual(said(...images.slice(0, 15)));
  });

  it("leaves out an image over 3,750,000 bytes", async () => {
    const { reads, read } = recorder();
    expect(loaded(await loadImages([said(part(4_000_000), part(3_750_000))], SONNET, read))).toEqual([false, true]);
    expect(reads).toHaveLength(1);
  });

  it("stops adding images once they would pass 15,000,000 bytes in all", async () => {
    const { read } = recorder();
    const big = () => part(3_700_000);
    expect(loaded(await loadImages([said(big(), big(), big(), big(), big())], SONNET, read))).toEqual([false, true, true, true, true]);
  });

  it("never reads an image for a model that may not see private content", async () => {
    const { reads, read } = recorder();
    const messages = [said(part())];
    expect(await loadImages(messages, "deepseek-flash", read)).toBe(messages);
    expect(reads).toEqual([]);
  });

  it("reads each image once: a later call with the same keys reuses the bytes", async () => {
    const { reads, read } = recorder();
    const messages = [said(part(), part())];
    await loadImages(messages, SONNET, read);
    expect(loaded(await loadImages(messages, SONNET, read))).toEqual([true, true]);
    expect(reads).toHaveLength(2);
  });
});
