import { getBytes } from "../workspace/storage.js";
import { modelInfo } from "./catalog.js";
import type { ImagePart, ModelMessage } from "./gateway.js";

// Claude's own limits are 5 MB per image as base64 (3.75 MB of bytes) and 32 MB per request; 15 MB leaves the
// request room for the rest of the thread.
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_TOTAL_BYTES = 15_000_000;
const CACHE_ENTRIES = 40;

/** Every turn of a run sends the thread's images again; an attachment's key never gets new bytes, so a copy never goes stale. */
const cache = new Map<string, string>();

async function base64Of(key: string, read: (key: string) => Promise<Uint8Array>): Promise<string> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (cache.size >= CACHE_ENTRIES) cache.clear();
  const data = Buffer.from(await read(key)).toString("base64");
  cache.set(key, data);
  return data;
}

/**
 * Fills in the bytes of the images a model call carries, newest first, within the limits; an image left out is still
 * named in its message's text. A model that may not see private content gets none, whatever the privacy gate decided.
 */
export async function loadImages(messages: ModelMessage[], model: string, read = getBytes): Promise<ModelMessage[]> {
  if (!modelInfo(model).privateOk) return messages;
  const chosen: ImagePart[] = [];
  let total = 0;
  for (const part of messages.flatMap((m) => (m.role === "user" ? m.images ?? [] : [])).reverse()) {
    if (chosen.length === MAX_IMAGES) break;
    if (part.size > MAX_IMAGE_BYTES || total + part.size > MAX_TOTAL_BYTES) continue;
    chosen.push(part);
    total += part.size;
  }
  const data = new Map(await Promise.all(chosen.map(async (part) => [part, await base64Of(part.key, read)] as const)));
  return messages.map((m) =>
    m.role === "user" && m.images
      ? { ...m, images: m.images.map((part) => (data.has(part) ? { ...part, data: data.get(part) } : part)) }
      : m,
  );
}
