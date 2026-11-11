import { randomUUID } from "node:crypto";
import {
  CopyObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ValidationError } from "../lib/errors.js";
import { filesBucket, missingObject, objects, s3 } from "../lib/s3.js";
import { MAX_ROOM_FILE_BYTES } from "./limits.js";
import type { StoredFile } from "./types.js";

const UPLOAD_EXPIRY_SEC = 5 * 60;
const DOWNLOAD_EXPIRY_SEC = 3600;
const DELETE_BATCH = 1000;

/**
 * Each version of a file is a new object, never an overwrite: a reader holding the old key still gets the old bytes,
 * and the old object is deleted only once the index points at the new one.
 */
export const newObjectKey = (roomId: string) => `workspaces/${roomId}/${randomUUID()}`;

/** The uploader's id in the key is what lets a commit refuse someone else's upload. */
export const stagingPrefix = (roomId: string, userId: string) => `staging/${roomId}/${userId}/`;

/**
 * A presigned POST, so S3 itself enforces the size and type; the file never passes through a Lambda. It lands in
 * staging, and joins the room only when its commit is accepted.
 */
export async function presignFileUpload(roomId: string, userId: string, file: { path: string; size: number; type: string }) {
  const uploadKey = `${stagingPrefix(roomId, userId)}${randomUUID()}`;
  const { url, fields } = await createPresignedPost(s3(), {
    Bucket: filesBucket(), Key: uploadKey, Expires: UPLOAD_EXPIRY_SEC, Fields: { "Content-Type": file.type },
    Conditions: [["content-length-range", 1, MAX_ROOM_FILE_BYTES], ["eq", "$Content-Type", file.type]],
  });
  return { url, fields, uploadKey };
}

/** The object as S3 stored it: the truth about an upload's size and type, where the uploader's are only a claim. */
export async function headObject(key: string) {
  try {
    const head = await objects().send(new HeadObjectCommand({ Bucket: filesBucket(), Key: key }));
    return { size: Number(head.ContentLength), contentType: head.ContentType ?? "application/octet-stream" };
  } catch (e) {
    if (missingObject(e)) throw new ValidationError("That upload isn't there; try again.");
    throw e;
  }
}

export async function getBytes(key: string): Promise<Uint8Array> {
  const { Body } = await objects().send(new GetObjectCommand({ Bucket: filesBucket(), Key: key }));
  return Body!.transformToByteArray();
}

export async function putBytes(key: string, bytes: Uint8Array, type: string) {
  await objects().send(new PutObjectCommand({ Bucket: filesBucket(), Key: key, Body: bytes, ContentType: type }));
}

/** Server side: the bytes never pass through the Lambda. */
export async function copyObject(from: string, to: string) {
  await objects().send(new CopyObjectCommand({ Bucket: filesBucket(), CopySource: `${filesBucket()}/${encodeURI(from)}`, Key: to }));
}

/**
 * Deleting a key that's already gone is not an error in S3. A batch delete answers 200 even when some keys failed,
 * listing those in `Errors`, so that list is checked too.
 */
export async function deleteObjects(keys: string[]) {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const Objects = keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key }));
    const { Errors } = await objects().send(new DeleteObjectsCommand({ Bucket: filesBucket(), Delete: { Objects, Quiet: true } }));
    if (Errors?.length) throw new Error(`S3 kept ${Errors.length} object(s): ${Errors[0]!.Code} ${Errors[0]!.Key}`);
  }
}

/**
 * Always a download, never rendered: a room file can be anything, and an HTML or SVG file shown inline could run
 * script. The header only carries printable ASCII, so other characters in the name become underscores.
 */
export function presignFileDownload(f: StoredFile): Promise<string> {
  const filename = f.path.slice(f.path.lastIndexOf("/") + 1).replace(/[^\x20-\x7e]|["\\]/g, "_");
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: filesBucket(), Key: f.objectKey, ResponseContentDisposition: `attachment; filename="${filename}"`,
  }), { expiresIn: DOWNLOAD_EXPIRY_SEC });
}
