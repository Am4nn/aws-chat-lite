import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { callerFromEvent } from "../lib/auth.js";
import { bestEffort } from "../lib/best-effort.js";
import { Conflict, NotFound, ValidationError } from "../lib/errors.js";
import { errorResponse, json, parseBody } from "../lib/http.js";
import { inlineType } from "../chat/files.js";
import { requireMember } from "../rooms/membership.js";
import { broadcastToRoom } from "../live/broadcast.js";
import { MAX_ROOM_FILE_BYTES, MAX_ROOM_FILES, OVER_QUOTA, ROOM_FILES_BYTES, TOO_BIG, TOO_MANY } from "./limits.js";
import { pathClash, workspacePath } from "./paths.js";
import { commitObject, roomFile, workspaceRepo, type WorkspaceRepo } from "./repo.js";
import * as storage from "./storage.js";
import { newObjectKey, stagingPrefix } from "./storage.js";
import type { FilesUpdated, RoomFile } from "./types.js";

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

export interface Deps {
  files: Pick<WorkspaceRepo, "list" | "get" | "usage" | "commit" | "remove" | "countUpload">;
  storage: Pick<
    typeof storage, "presignFileUpload" | "headObject" | "copyObject" | "deleteObjects" | "presignFileDownload" | "presignFileView"
  >;
  requireMember: typeof requireMember;
  notify: (roomId: string, event: FilesUpdated) => Promise<unknown>;
}

/** Browsers send an empty type for files they don't recognise; S3 needs one to fix in the upload policy. */
const contentType = (raw: unknown) =>
  typeof raw === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(raw) && raw.length <= 100 ? raw : "application/octet-stream";

function fileSize(raw: unknown): number {
  if (!Number.isInteger(raw) || (raw as number) < 1) throw new ValidationError("Empty files can't be uploaded.");
  if ((raw as number) > MAX_ROOM_FILE_BYTES) throw new ValidationError(TOO_BIG);
  return raw as number;
}

const clashError = (path: string, other: string) => new Conflict(`${path} clashes with ${other}: a file and a folder can't share a name.`);

/**
 * Room files over HTTP. Bytes never pass through this Lambda: an upload goes from the browser to a staging key on a
 * presigned POST, and its commit copies it to the room's own object inside S3 before the index points at it, so a
 * file the index names always exists. Every member may read and write the room's files.
 */
export function makeHandler(deps: Deps) {
  const changed = (roomId: string, files: RoomFile[], deleted: string[]) =>
    bestEffort("files.updated broadcast", () => deps.notify(roomId, { type: "files.updated", roomId, files, deleted }));

  return async (event: Event): Promise<APIGatewayProxyStructuredResultV2> => {
    const roomId = event.pathParameters?.roomId ?? "";
    const query = event.queryStringParameters ?? {};
    const body = parseBody(event) as Record<string, unknown> | null;
    if (body === null) return json(400, { error: "Body must be JSON." });
    try {
      const user = callerFromEvent(event);
      switch (event.routeKey) {
        case "GET /rooms/{roomId}/files": {
          await deps.requireMember(roomId, user.userId);
          const files = (await deps.files.list(roomId)).map(roomFile);
          return json(200, { files, usedBytes: files.reduce((n, f) => n + f.size, 0), limitBytes: ROOM_FILES_BYTES });
        }

        // A quick check of the room's limits before the browser spends time uploading; the commit enforces them.
        // Each signed upload may leave a 25 MB object in staging for a day, so members get only so many an hour.
        case "POST /rooms/{roomId}/files/uploads": {
          const path = workspacePath(body.path);
          const size = fileSize(body.size);
          await deps.requireMember(roomId, user.userId, { writing: true });
          await deps.files.countUpload(user.userId);
          const [files, usage] = await Promise.all([deps.files.list(roomId), deps.files.usage(roomId)]);
          const clash = pathClash(files.map((f) => f.path), path);
          if (clash) throw clashError(path, clash);
          const existing = files.find((f) => f.path === path);
          if (usage.bytes - (existing?.size ?? 0) + size > ROOM_FILES_BYTES) throw new ValidationError(OVER_QUOTA);
          if (!existing && usage.count >= MAX_ROOM_FILES) throw new ValidationError(TOO_MANY);
          return json(200, await deps.storage.presignFileUpload(roomId, user.userId, { path, size, type: contentType(body.type) }));
        }

        case "PUT /rooms/{roomId}/files": {
          const path = workspacePath(body.path);
          const uploadKey = typeof body.uploadKey === "string" ? body.uploadKey : "";
          if (!uploadKey.startsWith(stagingPrefix(roomId, user.userId))) throw new ValidationError("That upload isn't yours.");
          await deps.requireMember(roomId, user.userId, { writing: true });
          const clash = pathClash((await deps.files.list(roomId)).map((f) => f.path), path);
          if (clash) throw clashError(path, clash);
          const { size, contentType } = await deps.storage.headObject(uploadKey);
          if (size > MAX_ROOM_FILE_BYTES) throw new ValidationError(TOO_BIG);
          const objectKey = newObjectKey(roomId);
          await deps.storage.copyObject(uploadKey, objectKey);
          // A refused commit leaves the upload in staging, where it expires, so it can be tried again.
          const committed = await commitObject(deps, roomId, {
            path, objectKey, size, contentType, by: { kind: "member", userId: user.userId, name: user.username },
          }, [uploadKey]);
          const file = roomFile(committed.file);
          await changed(roomId, [file], []);
          return json(200, file);
        }

        case "GET /rooms/{roomId}/files/download": {
          const path = workspacePath(query.path);
          await deps.requireMember(roomId, user.userId);
          const file = await deps.files.get(roomId, path);
          if (!file) throw new NotFound("That file isn't in the room.");
          const type = file.contentType;
          const view = query.inline === "1" && inlineType(type);
          return json(200, { url: await (view ? deps.storage.presignFileView(file, type) : deps.storage.presignFileDownload(file)) });
        }

        case "DELETE /rooms/{roomId}/files": {
          const path = workspacePath(query.path);
          await deps.requireMember(roomId, user.userId, { writing: true });
          const { removed } = await deps.files.remove(roomId, path);
          if (!removed) throw new NotFound("That file isn't in the room.");
          await bestEffort("deleting a removed object", () => deps.storage.deleteObjects([removed.objectKey]));
          await changed(roomId, [], [path]);
          return { statusCode: 204 };
        }

        default:
          return json(404, { error: "No such route." });
      }
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// Built on first use, so tests can import makeHandler without a table configured.
let liveHandler: ReturnType<typeof makeHandler> | undefined;
export const handler = (event: Event) =>
  (liveHandler ??= makeHandler({ files: workspaceRepo(), storage, requireMember, notify: broadcastToRoom }))(event);
