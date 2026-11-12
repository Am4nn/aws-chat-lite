import { describe, it, expect, vi, afterEach } from "vitest";
import { S3Client, type HeadObjectCommand } from "@aws-sdk/client-s3";
import { ValidationError } from "../lib/errors.js";
import { attachmentKey, inlineType, presignDownload, presignUpload, storedAttachment } from "./files.js";

// Presigning is local computation; it needs credentials to sign with, never a network call.
Object.assign(process.env, {
  AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1",
  FILES_BUCKET: "cl-test-files", S3_PUBLIC_ENDPOINT: "http://localhost:4566",
});

const policyConditions = (fields: Record<string, string>) =>
  JSON.parse(Buffer.from(fields.Policy, "base64").toString("utf8")).conditions as unknown[];

describe("attachmentKey", () => {
  it("files the upload under the room and the uploader, with a safe name", () => {
    expect(attachmentKey("r", "u", "my report (1).pdf")).toMatch(/^rooms\/r\/u\/[0-9a-f-]{36}\/my-report--1-.pdf$/);
  });

  it("caps the name at 120 characters", () => {
    expect(attachmentKey("r", "u", "a".repeat(300)).split("/").pop()).toHaveLength(120);
  });
});

describe("inlineType", () => {
  it("shows only raster images inline (svg and html could run script)", () => {
    expect(inlineType("image/svg+xml")).toBe(false);
    expect(inlineType("text/html")).toBe(false);
    expect(inlineType("image/webp")).toBe(true);
  });
});

describe("presignUpload", () => {
  it("signs a POST that S3 refuses above 10 MB, fixed to the declared type", async () => {
    const form = await presignUpload("r", "u", { name: "a.png", size: 100, type: "image/png" });
    expect(form.key).toMatch(/^rooms\/r\/u\//);
    expect(form.url).toBe("http://localhost:4566/cl-test-files");
    expect(form.fields).toMatchObject({ key: form.key, "Content-Type": "image/png" });
    const conditions = policyConditions(form.fields);
    expect(conditions).toContainEqual(["content-length-range", 1, 10485760]);
    expect(conditions).toContainEqual(["eq", "$Content-Type", "image/png"]);
  });

  it("refuses a file over 10 MB or with no name", async () => {
    await expect(presignUpload("r", "u", { name: "big.bin", size: 10485761, type: "application/octet-stream" })).rejects.toThrow();
    await expect(presignUpload("r", "u", { name: "", size: 1, type: "text/plain" })).rejects.toThrow();
  });
});

describe("presignDownload", () => {
  const attachment = { key: "rooms/r/u/id/notes.html", name: "notes.html", size: 10, type: "text/html" };

  it("downloads anything that isn't a raster image as an attachment", async () => {
    const url = await presignDownload(attachment);
    expect(url).toContain("response-content-disposition=attachment");
    expect(url).toMatch(/X-Amz-Expires=3600/);
  });

  it("serves an inline image as its declared image type, whatever the upload claimed", async () => {
    const url = await presignDownload({ ...attachment, key: "rooms/r/u/id/a.png", name: "a.png", type: "image/png" });
    expect(url).not.toContain("response-content-disposition");
    expect(url).toContain("response-content-type=image%2Fpng");
  });
});

describe("storedAttachment", () => {
  afterEach(() => vi.restoreAllMocks());
  const declared = { key: "rooms/r/u/id/a.png", name: "a.png", size: 10, type: "image/png" };

  it("takes the size and type from what S3 stored, not from what the sender declared", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation((async () => ({ ContentLength: 5_000_000, ContentType: "text/html" })) as never);
    expect(await storedAttachment(declared)).toEqual({ ...declared, size: 5_000_000, type: "text/html" });
    expect((send.mock.calls[0][0] as HeadObjectCommand).input).toEqual({ Bucket: "cl-test-files", Key: declared.key });
  });

  it("refuses a file that was never uploaded, whether S3 says 404 or (without ListBucket, as on AWS) 403", async () => {
    for (const [name, status] of [["NotFound", 404], ["Unknown", 403]] as const) {
      vi.spyOn(S3Client.prototype, "send").mockImplementation((async () => {
        throw Object.assign(new Error("no"), { name, $metadata: { httpStatusCode: status } });
      }) as never);
      await expect(storedAttachment(declared), name).rejects.toThrow(new ValidationError("That upload isn't there; try again."));
    }
  });
});
