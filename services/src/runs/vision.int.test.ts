import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { roomsRepo } from "../rooms/repo.js";
import { chatRepo } from "../chat/repo.js";
import { attachmentKey } from "../chat/files.js";
import { png } from "../models/image-fixtures.js";
import { PICK_REFUSED } from "../models/privacy.js";
import { routeSend } from "../threads/route.js";
import { putBytes } from "../workspace/storage.js";

// Runs against the deployed run function on Floci: npm run floci:up && npm run deploy:local, then npm -w services run test:int
const outputs = JSON.parse(readFileSync(new URL("../../../infra/cdk.out/outputs-local.json", import.meta.url), "utf8"));
process.env.WS_CALLBACK_URL = String(outputs["cl-local-core"].WsUrl).replace(/^ws/, "http");
process.env.RUN_FN_NAME = "cl-local-run";
process.env.RUN_FN_QUALIFIER = "live";

const chat = chatRepo();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let clients = 0;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** A room whose owner has uploaded a PNG, ready to attach. */
async function withImage(bytes: Uint8Array = PIXEL) {
  const owner = { userId: randomUUID(), username: "owner" };
  const { roomId, generalChatId } = await roomsRepo().createRoom(owner, "Vision");
  const key = attachmentKey(roomId, owner.userId, "pixel.png");
  await putBytes(key, bytes, "image/png");
  return { owner, roomId, generalChatId, image: { key, name: "pixel.png", size: bytes.length, type: "image/png" } };
}

describe("images on Floci", { timeout: 60_000 }, () => {
  it("@agent with an image: the model gets the image itself", async () => {
    const { owner, roomId, generalChatId, image } = await withImage();
    const ask = { roomId, chatId: generalChatId, clientId: `k${++clients}`, text: "@agent what is this tools:0", attachments: [image] };
    await (await routeSend(owner, ask)).route();

    const [card] = (await chat.history(owner, roomId, generalChatId, {})).messages;
    const threadId = card!.threadRef!.threadId;
    const answer = await until("the answer", async () =>
      (await chat.history(owner, roomId, threadId, {})).messages.find((m) => m.authorId === "agent"));
    expect(answer.agent).toMatchObject({ status: "done" });
    expect(answer.text.split("\n")[0]).toMatch(/\(saw 1 image\)$/);
  });

  it("an image Claude would refuse is only named, and the run still answers", async () => {
    const { owner, roomId, generalChatId, image } = await withImage(png(1440, 12000));
    const ask = { roomId, chatId: generalChatId, clientId: `k${++clients}`, text: "@agent what is this tools:0", attachments: [image] };
    await (await routeSend(owner, ask)).route();

    const [card] = (await chat.history(owner, roomId, generalChatId, {})).messages;
    const threadId = card!.threadRef!.threadId;
    const answer = await until("the answer", async () =>
      (await chat.history(owner, roomId, threadId, {})).messages.find((m) => m.authorId === "agent"));
    expect(answer.agent).toMatchObject({ status: "done" });
    expect(answer.text.split("\n")[0]).not.toMatch(/saw/);
  });

  it("a DeepSeek pick with an image is refused before anything is stored", async () => {
    const { owner, roomId, generalChatId, image } = await withImage();
    const ask = { roomId, chatId: generalChatId, clientId: `k${++clients}`, text: "@agent what is this", attachments: [image], model: "deepseek-flash" };
    await expect(routeSend(owner, ask)).rejects.toThrow(PICK_REFUSED);
    expect((await chat.history(owner, roomId, generalChatId, {})).messages).toEqual([]);
  });
});
