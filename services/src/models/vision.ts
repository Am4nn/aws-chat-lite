import { getBytes } from "../workspace/storage.js";
import { modelInfo } from "./catalog.js";
import type { ImagePart, InlineImageType, ModelMessage } from "./gateway.js";
import { imageSize, imageType } from "./image-header.js";

// Claude's own limits are 5 MB per image as base64 (3.75 MB of bytes) and 32 MB per request; 15 MB leaves the
// request room for the rest of the thread.
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_TOTAL_BYTES = 15_000_000;
/** Claude refuses a whole request over one image above 8000 px on a side (2000 px past 20 images, which MAX_IMAGES rules out). */
const MAX_SIDE = 8000;
const CACHE_ENTRIES = 40;

/** What Claude is sent for an image, or null for one it would refuse, which is then only named. */
type Sendable = { mediaType: InlineImageType; data: string } | null;

/** Every turn of a run sends the thread's images again; an attachment's key never gets new bytes, so a copy never goes stale. */
const cache = new Map<string, Sendable>();

/**
 * Claude refuses the whole request over one image whose bytes don't match its media type or that is too big, and every
 * later run in the thread would send it again. So the type comes from the bytes, not from the browser that uploaded it.
 */
function sendable(bytes: Uint8Array): Sendable {
  const mediaType = imageType(bytes);
  const size = mediaType ? imageSize(bytes, mediaType) : undefined;
  if (!mediaType || !size || size.width > MAX_SIDE || size.height > MAX_SIDE) return null;
  return { mediaType, data: Buffer.from(bytes).toString("base64") };
}

async function load(key: string, read: (key: string) => Promise<Uint8Array>): Promise<Sendable> {
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size >= CACHE_ENTRIES) cache.clear();
  const loaded = sendable(await read(key));
  cache.set(key, loaded);
  return loaded;
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
  const loaded = new Map(await Promise.all(chosen.map(async (part) => [part, await load(part.key, read)] as const)));
  return messages.map((m) =>
    m.role === "user" && m.images
      ? { ...m, images: m.images.map((part) => ({ ...part, ...loaded.get(part) })) }
      : m,
  );
}
