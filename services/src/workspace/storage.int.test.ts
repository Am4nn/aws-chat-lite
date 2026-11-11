import { describe, it, expect } from "vitest";
import { ValidationError } from "../lib/errors.js";
import { copyObject, deleteObjects, getBytes, headObject, newObjectKey, presignFileUpload, putBytes } from "./storage.js";

// Runs against S3 on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
describe("room file storage on Floci", () => {
  it("an upload lands in staging, copies into the room byte for byte, and is gone once deleted", async () => {
    const bytes = new TextEncoder().encode("hello, room");
    const form = await presignFileUpload("r", "u", { path: "notes.md", size: bytes.length, type: "text/markdown" });
    const post = new FormData();
    for (const [k, v] of Object.entries(form.fields)) post.append(k, v);
    post.append("file", new Blob([bytes]));
    expect((await fetch(form.url, { method: "POST", body: post })).ok).toBe(true);
    expect(await headObject(form.uploadKey)).toEqual({ size: bytes.length, contentType: "text/markdown" });

    const key = newObjectKey("r");
    await copyObject(form.uploadKey, key);
    expect(await getBytes(key)).toEqual(bytes);
    expect(await headObject(key)).toEqual({ size: bytes.length, contentType: "text/markdown" });

    await deleteObjects([form.uploadKey, key]);
    await expect(headObject(key)).rejects.toBeInstanceOf(ValidationError);
  });

  it("writes bytes the sandbox made and reads them back", async () => {
    const key = newObjectKey("r");
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    await putBytes(key, bytes, "application/octet-stream");
    expect(await getBytes(key)).toEqual(bytes);
    await deleteObjects([key]);
  });
});
