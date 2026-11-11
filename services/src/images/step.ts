import { bestEffort } from "../lib/best-effort.js";
import { broadcastToRoom } from "../live/broadcast.js";
import type { TokenUsage } from "../models/catalog.js";
import { imageModel } from "../models/images.js";
import type { Run } from "../runs/repo.js";
import type { Aspect, GeneratedImage, RunEvent } from "../threads/types.js";
import { MAX_ROOM_FILES, ROOM_FILES_BYTES } from "../workspace/limits.js";
import { QuotaError, roomFile, workspaceRepo, type WorkspaceRepo } from "../workspace/repo.js";
import { copyObject, deleteObjects, findObject, newObjectKey, putBytes } from "../workspace/storage.js";
import type { FilesSynced, FilesUpdated } from "../workspace/types.js";

export const ASPECTS: readonly Aspect[] = ["1:1", "3:4", "4:3", "9:16", "16:9"];

const MAX_PROMPT = 2000;
/** Room for the largest image Gemini's reply can carry, checked before paying for one. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BAD_PROMPT = "Describe the image in 1 to 2000 characters.";
const FULL = "The room's files are full, so the image has nowhere to go.";
const LOST = "Gemini didn't make that image.";
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

type Cost = { usage: TokenUsage; costMicros: number };
type RunRef = Pick<Run, "runId" | "roomId" | "threadId" | "number" | "firstSeq">;

export interface ImageDeps {
  generate: ReturnType<typeof imageModel>["generate"];
  files: Pick<WorkspaceRepo, "usage" | "commit">;
  storage: { findObject: typeof findObject; putBytes: typeof putBytes; copyObject: typeof copyObject; deleteObjects: typeof deleteObjects };
  /** Charges the call to the run and the room, logged as image usage for this step. */
  bill: (cost: Cost) => Promise<unknown>;
  notify: (roomId: string, event: FilesUpdated) => Promise<unknown>;
}

let model: ReturnType<typeof imageModel> | undefined;

export const imageDeps = (bill: ImageDeps["bill"]): ImageDeps => ({
  generate: (request) => (model ??= imageModel()).generate(request),
  files: workspaceRepo(),
  storage: { findObject, putBytes, copyObject, deleteObjects },
  bill,
  notify: broadcastToRoom,
});

/**
 * `images/<thread>-<run>-<step>-<first four words>.<ext>`. Steps restart at 1 in every run, so the run (its first
 * message's seq) keeps "again, but watercolor" from replacing the first picture. The name stays the same on a retry,
 * which then finds its own file instead of saving a second copy.
 */
export function imagePath(run: Pick<Run, "number" | "firstSeq">, step: number, label: string, mediaType: string): string {
  const slug = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4).join("-").slice(0, 40).replace(/-$/, "");
  return `images/${run.number}-${run.firstSeq}-${step}-${slug || "image"}.${EXTENSIONS[mediaType] ?? "png"}`;
}

/** Where a step's image waits between Gemini and the room's files; the bucket clears it after a day. */
const stagingKey = (runId: string, step: number) => `generated/${runId}/${step}`;

type ImageStep = { ok: boolean; output: string; image?: GeneratedImage; synced?: FilesSynced };

/**
 * One `image_generate` call, the run's step `step`. Gemini bills every image, so a retried step never pays twice:
 * each part is skipped when an earlier attempt left its trace. The staged object means Gemini already answered (its
 * cost rides along as metadata), an image usage event for the step means it was billed, and the step's `files.synced`
 * means the room already has the file. The image is never shown to the model, only its path.
 */
export async function generateImageStep(
  run: RunRef, step: number, input: Record<string, unknown>, events: RunEvent[], deps: ImageDeps,
): Promise<ImageStep> {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT) return { ok: false, output: BAD_PROMPT };
  const aspect = ASPECTS.find((a) => a === input.aspect) ?? "1:1";
  const saved = (path: string): ImageStep => ({
    ok: true, output: `Saved ${path} (${aspect}). It shows in the thread and in the room's files.`, image: { path, aspect },
    synced: { written: [path], deleted: [], notes: [] },
  });
  const synced = events.find((e) => e.type === "files.synced" && e.step === step);
  if (synced?.type === "files.synced") return saved(synced.written[0]!);

  const billed = events.some((e) => e.type === "usage" && e.job === "image" && e.step === step);
  const key = stagingKey(run.runId, step);
  let staged = await deps.storage.findObject(key);
  if (!staged) {
    // An image is staged before it is billed, so a charge without one was a failure, already reported once.
    if (billed) return { ok: false, output: LOST };
    const usage = await deps.files.usage(run.roomId);
    if (usage.bytes + MAX_IMAGE_BYTES > ROOM_FILES_BYTES || usage.count >= MAX_ROOM_FILES) return { ok: false, output: FULL };
    const made = await deps.generate({ prompt, aspect });
    if (!made.ok) {
      if (made.costMicros > 0) await deps.bill(made);
      return { ok: false, output: made.error };
    }
    const metadata = { cost: JSON.stringify({ usage: made.usage, costMicros: made.costMicros } satisfies Cost) };
    await deps.storage.putBytes(key, made.bytes, made.mediaType, metadata);
    staged = { size: made.bytes.length, contentType: made.mediaType, metadata };
  }
  if (!billed) await deps.bill(JSON.parse(staged.metadata.cost!) as Cost);

  const name = typeof input.name === "string" && input.name.trim() ? input.name : prompt;
  const path = imagePath(run, step, name, staged.contentType);
  const objectKey = newObjectKey(run.roomId);
  await deps.storage.copyObject(key, objectKey);
  let committed;
  try {
    const by = { kind: "thread" as const, threadId: run.threadId, number: run.number };
    committed = await deps.files.commit(run.roomId, { path, objectKey, size: staged.size, contentType: staged.contentType, by });
  } catch (e) {
    await bestEffort("dropping a refused image", () => deps.storage.deleteObjects([objectKey]));
    if (e instanceof QuotaError) return { ok: false, output: FULL };
    throw e;
  }
  const { file, replaced } = committed;
  if (replaced) await bestEffort("deleting a replaced object", () => deps.storage.deleteObjects([replaced.objectKey]));
  const updated: FilesUpdated = { type: "files.updated", roomId: run.roomId, files: [roomFile(file)], deleted: [] };
  await bestEffort("files.updated broadcast", () => deps.notify(run.roomId, updated));
  return saved(path);
}
