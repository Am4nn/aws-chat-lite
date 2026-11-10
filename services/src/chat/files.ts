import { randomUUID } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_FILE_BYTES, validAttachment, type Attachment, type Message } from "./model.js";

const UPLOAD_EXPIRY_SEC = 5 * 60;
const DOWNLOAD_EXPIRY_SEC = 3600;
const MAX_SAFE_NAME = 120;

/** Raster images only: an SVG or HTML file shown inline could run script. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

let cached: S3Client | undefined;

/**
 * Signing is local computation, so this client only has to produce URLs the browser can reach. Locally that is
 * Floci's host as the browser sees it (the Lambda's own endpoint is an address inside Docker), path style because
 * that's how Floci serves buckets; on AWS it is the regional S3 endpoint.
 */
function s3() {
  const endpoint = process.env.S3_PUBLIC_ENDPOINT;
  return (cached ??= new S3Client(endpoint ? { endpoint, forcePathStyle: true } : {}));
}

function bucket() {
  const b = process.env.FILES_BUCKET;
  if (!b) throw new Error("FILES_BUCKET not set");
  return b;
}

/** The uploader's id in the key is what lets `send` refuse someone else's upload. */
export function attachmentKey(roomId: string, userId: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, MAX_SAFE_NAME);
  return `rooms/${roomId}/${userId}/${randomUUID()}/${safe}`;
}

export const inlineType = (type: string) => INLINE_TYPES.has(type);

/**
 * A presigned POST rather than a presigned PUT, because only a POST policy can make S3 itself enforce the size
 * limit (`content-length-range`); the file never passes through a Lambda.
 */
export async function presignUpload(roomId: string, userId: string, input: unknown) {
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name : "";
  const { key, type } = validAttachment({ ...raw, key: attachmentKey(roomId, userId, name) }, roomId, userId);
  const { url, fields } = await createPresignedPost(s3(), {
    Bucket: bucket(), Key: key, Expires: UPLOAD_EXPIRY_SEC, Fields: { "Content-Type": type },
    Conditions: [["content-length-range", 1, MAX_FILE_BYTES], ["eq", "$Content-Type", type]],
  });
  return { url, fields, key };
}

/**
 * The response type and disposition are fixed by the signed URL, not by what the uploader stored: an image is served
 * as the image type the message declares, and anything else downloads instead of rendering.
 */
export function presignDownload(a: Attachment): Promise<string> {
  const filename = a.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: bucket(), Key: a.key,
    ...(inlineType(a.type)
      ? { ResponseContentType: a.type }
      : { ResponseContentDisposition: `attachment; filename="${filename}"` }),
  }), { expiresIn: DOWNLOAD_EXPIRY_SEC });
}

/** Messages are stored without URLs (they expire); each read signs fresh ones. */
export async function withUrls(message: Message): Promise<Message> {
  if (!message.attachments.length) return message;
  const attachments = await Promise.all(message.attachments.map(async (a) => ({ ...a, url: await presignDownload(a) })));
  return { ...message, attachments };
}
