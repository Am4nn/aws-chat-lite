import { bff } from "./bff";

const MAX_FILE_BYTES = 10_485_760;
const MAX_FILES = 5;

/** Raster images only. The server serves anything else as a download, so an SVG or HTML file can never run script. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const isInlineImage = (type: string) => INLINE_TYPES.has(type);

/** The checks S3's upload policy and `send` would enforce anyway, made up front so the user hears why at once. */
export function screenFiles<F extends { name: string; size: number }>(files: F[], alreadyAttached: number) {
  const errors: string[] = [];
  const small = files.filter((f) => {
    if (f.size <= MAX_FILE_BYTES) return true;
    errors.push(`${f.name} is over 10 MB.`);
    return false;
  });
  const room = Math.max(0, MAX_FILES - alreadyAttached);
  if (small.length > room) errors.push(`At most ${MAX_FILES} files per message.`);
  return { accepted: small.slice(0, room), errors };
}

/**
 * Asks the API for a presigned POST, then sends the file straight to S3 with it; the file never passes through a
 * Lambda. Returns the object key that `send` attaches.
 */
export async function uploadFile(roomId: string, file: File, signal: AbortSignal): Promise<string> {
  const type = file.type || "application/octet-stream";
  const form = await bff<{ url: string; fields: Record<string, string>; key: string }>(
    `/bff/api/rooms/${roomId}/attachments`, { body: { name: file.name, size: file.size, type } },
  );
  const body = new FormData();
  for (const [k, v] of Object.entries(form.fields)) body.append(k, v);
  body.append("file", file);
  const res = await fetch(form.url, { method: "POST", body, signal });
  if (!res.ok) throw new Error(`${file.name} didn't upload.`);
  return form.key;
}
