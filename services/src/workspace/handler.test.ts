import { describe, it, expect, vi } from "vitest";
import { Gone } from "../lib/errors.js";
import { makeHandler, type Deps } from "./handler.js";
import { OVER_QUOTA, ROOM_FILES_BYTES, TOO_BIG } from "./limits.js";
import { BAD_PATH } from "./paths.js";
import { QuotaError } from "./repo.js";
import type { StoredFile } from "./types.js";

const stored = (path: string, o: Partial<StoredFile> = {}): StoredFile => ({
  path, size: 5, contentType: "text/plain", v: 1, updatedAt: "2026-11-11T00:00:00.000Z",
  updatedBy: { kind: "member", userId: "u1", name: "aman" }, objectKey: `workspaces/r/old-${path}`, ...o,
});

function fakes(files: StoredFile[] = []) {
  const deps = {
    files: {
      list: vi.fn(async () => files),
      get: vi.fn(async (_r: string, path: string) => files.find((f) => f.path === path)),
      usage: vi.fn(async () => ({ bytes: files.reduce((n, f) => n + f.size, 0), count: files.length })),
      commit: vi.fn(async (_r: string, c: Parameters<Deps["files"]["commit"]>[1]) => {
        const prev = files.find((f) => f.path === c.path);
        const { by, ...rest } = c;
        return { file: { ...rest, v: (prev?.v ?? 0) + 1, updatedAt: "now", updatedBy: by }, ...(prev && { replaced: prev }) };
      }),
      remove: vi.fn(async (_r: string, path: string) => ({ removed: files.find((f) => f.path === path) })),
    },
    storage: {
      presignFileUpload: vi.fn(async () => ({ url: "http://s3/b", fields: {}, uploadKey: "staging/r/u1/k" })),
      headObject: vi.fn(async () => ({ size: 7, contentType: "text/markdown" })),
      copyObject: vi.fn(async () => {}),
      deleteObjects: vi.fn(async () => {}),
      presignFileDownload: vi.fn(async () => "http://s3/b/dl"),
    },
    requireMember: vi.fn(async () => "member" as const),
    notify: vi.fn(async () => {}),
  };
  return { deps, handle: makeHandler(deps as unknown as Deps) };
}

const ev = (routeKey: string, o: { body?: unknown; query?: Record<string, string> } = {}) => ({
  routeKey,
  body: o.body === undefined ? undefined : JSON.stringify(o.body),
  pathParameters: { roomId: "r" },
  queryStringParameters: o.query,
  requestContext: { authorizer: { jwt: { claims: { sub: "u1", "cognito:username": "aman" } } } },
}) as any;

const result = (res: { statusCode?: number; body?: string }) => ({ status: res.statusCode, body: res.body && JSON.parse(res.body) });
const upload = (body: unknown) => ev("POST /rooms/{roomId}/files/uploads", { body });
const commit = (body: unknown) => ev("PUT /rooms/{roomId}/files", { body });

describe("files handler", () => {
  it("refuses an upload outside the workspace or over 25 MB, before signing anything", async () => {
    const { deps, handle } = fakes();
    expect(result(await handle(upload({ path: "../x", size: 1, type: "text/plain" })))).toEqual({ status: 400, body: { error: BAD_PATH } });
    expect(result(await handle(upload({ path: "a.txt", size: 26_214_401, type: "text/plain" })))).toEqual({ status: 400, body: { error: TOO_BIG } });
    expect(deps.storage.presignFileUpload).not.toHaveBeenCalled();
  });

  it("signs an upload, refusing one that would take the room past 100 MB (an overwrite counts its difference)", async () => {
    const { deps, handle } = fakes([stored("a.txt", { size: 5 }), stored("big.bin", { size: ROOM_FILES_BYTES - 8 })]);
    expect(result(await handle(upload({ path: "a.txt", size: 8, type: "text/plain" })))).toEqual({
      status: 200, body: { url: "http://s3/b", fields: {}, uploadKey: "staging/r/u1/k" },
    });
    expect(deps.storage.presignFileUpload).toHaveBeenCalledWith("r", "u1", { path: "a.txt", size: 8, type: "text/plain" });
    expect(result(await handle(upload({ path: "a.txt", size: 9, type: "text/plain" })))).toEqual({ status: 400, body: { error: OVER_QUOTA } });
  });

  it("an archived room takes no uploads", async () => {
    const { deps, handle } = fakes();
    deps.requireMember.mockRejectedValue(new Gone("This room is archived."));
    expect((await handle(upload({ path: "a.txt", size: 1, type: "text/plain" }))).statusCode).toBe(410);
    expect(deps.requireMember).toHaveBeenCalledWith("r", "u1", { writing: true });
  });

  it("refuses to commit someone else's upload", async () => {
    const { deps, handle } = fakes();
    expect(result(await handle(commit({ path: "a.txt", uploadKey: "staging/r/other/u" })))).toEqual({
      status: 400, body: { error: "That upload isn't yours." },
    });
    expect(deps.storage.copyObject).not.toHaveBeenCalled();
  });

  it("refuses a file where a folder of that name exists", async () => {
    const { handle } = fakes([stored("a/b.txt")]);
    expect(result(await handle(commit({ path: "a", uploadKey: "staging/r/u1/k" })))).toEqual({
      status: 409, body: { error: "a clashes with a/b.txt: a file and a folder can't share a name." },
    });
  });

  it("commits S3's own size and type, drops the replaced object and the upload, and tells the room", async () => {
    const old = stored("a.txt");
    const { deps, handle } = fakes([old]);
    const res = result(await handle(commit({ path: "a.txt", uploadKey: "staging/r/u1/k" })));
    const [, c] = deps.files.commit.mock.calls[0]!;
    expect(deps.storage.copyObject).toHaveBeenCalledWith("staging/r/u1/k", c.objectKey);
    expect(c).toEqual({
      path: "a.txt", objectKey: expect.stringMatching(/^workspaces\/r\/[0-9a-f-]{36}$/), size: 7, contentType: "text/markdown",
      by: { kind: "member", userId: "u1", name: "aman" },
    });
    const file = { path: "a.txt", size: 7, contentType: "text/markdown", v: 2, updatedAt: "now", updatedBy: c.by };
    expect(res).toEqual({ status: 200, body: file });
    expect(deps.storage.deleteObjects).toHaveBeenCalledWith([old.objectKey, "staging/r/u1/k"]);
    expect(deps.notify).toHaveBeenCalledWith("r", { type: "files.updated", roomId: "r", files: [file], deleted: [] });
  });

  it("an upload S3 holds at over 25 MB is refused", async () => {
    const { deps, handle } = fakes();
    deps.storage.headObject.mockResolvedValue({ size: 26_214_401, contentType: "text/plain" });
    expect(result(await handle(commit({ path: "a.txt", uploadKey: "staging/r/u1/k" })))).toEqual({ status: 400, body: { error: TOO_BIG } });
    expect(deps.storage.copyObject).not.toHaveBeenCalled();
  });

  it("a commit over quota deletes its copy, keeps the upload and tells nobody", async () => {
    const { deps, handle } = fakes();
    deps.files.commit.mockRejectedValue(new QuotaError(OVER_QUOTA));
    expect(result(await handle(commit({ path: "a.txt", uploadKey: "staging/r/u1/k" })))).toEqual({ status: 400, body: { error: OVER_QUOTA } });
    const [, copy] = deps.storage.copyObject.mock.calls[0] as unknown as [string, string];
    expect(deps.storage.deleteObjects.mock.calls).toEqual([[[copy]]]);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("a delete answers 204 and tells the room once", async () => {
    const old = stored("a.txt");
    const { deps, handle } = fakes([old]);
    const res = await handle(ev("DELETE /rooms/{roomId}/files", { query: { path: "a.txt" } }));
    expect(res.statusCode).toBe(204);
    expect(deps.storage.deleteObjects).toHaveBeenCalledWith([old.objectKey]);
    expect(deps.notify.mock.calls).toEqual([["r", { type: "files.updated", roomId: "r", files: [], deleted: ["a.txt"] }]]);
  });

  it("deleting or downloading a file the room doesn't have is a 404", async () => {
    const { deps, handle } = fakes();
    expect((await handle(ev("DELETE /rooms/{roomId}/files", { query: { path: "a.txt" } }))).statusCode).toBe(404);
    expect((await handle(ev("GET /rooms/{roomId}/files/download", { query: { path: "a.txt" } }))).statusCode).toBe(404);
    expect((await handle(ev("GET /rooms/{roomId}/files/download", { query: { path: "/etc/passwd" } }))).statusCode).toBe(400);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("a download is a signed URL", async () => {
    const { deps, handle } = fakes([stored("a.txt")]);
    expect(result(await handle(ev("GET /rooms/{roomId}/files/download", { query: { path: "a.txt" } })))).toEqual({
      status: 200, body: { url: "http://s3/b/dl" },
    });
    expect(deps.storage.presignFileDownload).toHaveBeenCalledWith(stored("a.txt"));
    expect(deps.requireMember).toHaveBeenCalledWith("r", "u1");
  });

  it("the listing never shows object keys, and reports the room's usage against its limit", async () => {
    const { handle } = fakes([stored("a.txt", { size: 5 }), stored("b.txt", { size: 6 })]);
    const { status, body } = result(await handle(ev("GET /rooms/{roomId}/files")));
    expect(status).toBe(200);
    expect(body.files.map((f: object) => Object.keys(f).sort())).toEqual(Array(2).fill(["contentType", "path", "size", "updatedAt", "updatedBy", "v"]));
    expect(body).toMatchObject({ usedBytes: 11, limitBytes: ROOM_FILES_BYTES });
  });
});
