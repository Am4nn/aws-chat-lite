import { describe, it, expect } from "vitest";
import { newObjectKey, presignFileDownload, presignFileUpload, stagingPrefix } from "./storage.js";

// Presigning is local computation; it needs credentials to sign with, never a network call.
Object.assign(process.env, {
  AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1",
  FILES_BUCKET: "cl-test-files", S3_PUBLIC_ENDPOINT: "http://localhost:4566",
});

describe("room file storage", () => {
  it("keeps one object per live file under the room, and uploads under the uploader", () => {
    expect(newObjectKey("r")).toMatch(/^workspaces\/r\/[0-9a-f-]{36}$/);
    expect(stagingPrefix("r", "u")).toBe("staging/r/u/");
  });

  it("signs a POST that S3 refuses above 25 MB, fixed to the declared type", async () => {
    const form = await presignFileUpload("r", "u", { path: "a/b.md", size: 10, type: "text/markdown" });
    expect(form.uploadKey).toMatch(/^staging\/r\/u\/[0-9a-f-]{36}$/);
    expect(form.fields).toMatchObject({ key: form.uploadKey, "Content-Type": "text/markdown" });
    const { conditions } = JSON.parse(Buffer.from(form.fields.Policy!, "base64").toString("utf8"));
    expect(conditions).toContainEqual(["content-length-range", 1, 26_214_400]);
    expect(conditions).toContainEqual(["eq", "$Content-Type", "text/markdown"]);
  });

  it("always downloads, named by the file's ASCII-safe basename", async () => {
    const url = await presignFileDownload({
      path: 'docs/it\'s "x" é.html', size: 1, contentType: "text/html", v: 1, updatedAt: "t",
      updatedBy: { kind: "thread", threadId: "t", number: 3 }, objectKey: "workspaces/r/k",
    });
    const disposition = new URL(url).searchParams.get("response-content-disposition");
    expect(disposition).toBe('attachment; filename="it\'s _x_ _.html"');
  });
});
