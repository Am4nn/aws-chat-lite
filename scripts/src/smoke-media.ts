/**
 * Media and notifications between real browsers, all on fakes: an image the fake model sees, an image the fake Gemini
 * draws, read aloud with the fake Polly, dictation through the fake Transcribe and Chrome's fake microphone, a mention
 * push recorded by the fake sender, the service worker showing (or holding back) a push, and the phone layout.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ElementHandle, HTTPResponse, Page } from "puppeteer-core";
import { WEB, bff, check, eventually, noSideScroll, sampleFrames, say, send, sleep, socketOpen, until } from "./smoke-page.js";

type Person = { page: Page; name: string };
type Thread = { threadId: string; number: number; status: string };
type Message = { authorId: string; text: string; agent?: { costMicros: number } };

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** The fake Transcribe's words, in the order it hears them (two a second of audio). */
const TRANSCRIPT = "this is a fake transcript";
/** Transcribe streaming in Sydney, billed per second. */
const TRANSCRIBE_MICROS_PER_SEC = 167;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
/** A subscription the server accepts: an allowed push host, an uncompressed P-256 point and a 16-byte secret. */
const syntheticSubscription = (stamp: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/smoke-${stamp}`,
  keys: { p256dh: b64url(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))), auth: b64url(new Uint8Array(16).fill(7)) },
});

/** Counts the frames in which the dictation strip is still fading or growing, for 600 ms from the Dictate click. */
const DICTATION_ROW_FRAMES = sampleFrames({
  vars: "let moving = 0;",
  perFrame: `const row = document.querySelector('button.ml-auto[aria-label="Stop dictating"]')?.closest("div.overflow-hidden");
    if (row && Number(getComputedStyle(row).opacity) < 1) moving++;`,
  done: "now - start > 600",
  result: "moving",
  begin: `document.querySelector('button[aria-label="Dictate"]').click();`,
});

export async function mediaChecks(stamp: number, owner: Person, guest: Person) {
  const A = owner.page;
  const B = guest.page;
  const { roomId, generalChatId: general } = (await bff(A, "/bff/api/rooms", "POST", { name: `media ${stamp}` })).body as { roomId: string; generalChatId: string };
  const { code } = (await bff(A, `/bff/api/rooms/${roomId}/invite`, "POST", {})).body;
  await bff(B, `/bff/api/invites/${code}/accept`, "POST", {});

  const room = async () => (await bff(A, `/bff/api/rooms/${roomId}`)).body as {
    threads: Thread[]; budget: { spentMicros: number }; members: { userId: string; username: string }[];
  };
  const thread = async (n: number) => (await room()).threads.find((t) => t.number === n)!;
  const settled = (n: number) => eventually(() => thread(n), (t) => t.status !== "running");
  const answers = async (t: Thread) =>
    ((await bff(A, `/bff/api/rooms/${roomId}/chats/${t.threadId}/messages`)).body.messages as Message[]).filter((m) => m.authorId === "agent");
  const start = async (text: string) =>
    (await bff(A, `/bff/api/rooms/${roomId}/threads`, "POST", { text, clientId: crypto.randomUUID() })).body.thread as Thread;
  const open = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea#composer");
    await socketOpen(page);
  };
  const threadUrl = (n: number) => `${WEB}/r/${roomId}/t/${n}`;
  const generalUrl = `${WEB}/r/${roomId}/c/${general}`;

  // 1. Vision: a PNG attached in a thread reaches the fake model as an image.
  const dir = mkdtempSync(join(tmpdir(), "cl-smoke-media-"));
  writeFileSync(join(dir, "dot.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
  const looked = await start("hello tools:0 words:2");
  await settled(looked.number);
  await open(A, threadUrl(looked.number));
  await ((await A.$("input[type=file]")) as ElementHandle<HTMLInputElement>).uploadFile(join(dir, "dot.png"));
  await until(A, () => [...document.querySelectorAll("main")].some((m) => m.textContent?.includes("dot.png")));
  await sleep(1000);
  await send(A, "@agent what is this tools:0 words:3");
  const saw = await eventually(() => answers(looked), (ms) => ms.some((m) => m.text.includes("(saw 1 image)")));
  check(saw.some((m) => m.text.includes("(saw 1 image)")), "an attached PNG reaches the model as an image (the fake answers \"(saw 1 image)\")");

  // 2. Image: the fake Gemini draws, the thread shows it, Files lists it, and the run is charged for it.
  const drew = await start("draw call:image_generate tools:0 words:3");
  await settled(drew.number);
  await open(A, threadUrl(drew.number));
  const shown = await until(A, () => [...document.querySelectorAll('main img[alt^="images/"]')]
    .some((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), undefined, 15_000);
  const files = (await bff(A, `/bff/api/rooms/${roomId}/files`)).body.files as { path: string }[];
  const saved = files.find((f) => /^images\/.+\.png$/.test(f.path));
  const [drawn] = await answers(drew);
  const cost = drawn?.agent?.costMicros ?? 0;
  check(shown && !!saved && cost >= 67_000,
    `image_generate saves ${saved?.path ?? "no image"}, the thread shows it, and the run costs $${(cost / 1e6).toFixed(4)} (≥ $0.067)`);

  // 3. Read aloud: the answer's MP3 comes back as audio/mpeg and the button turns into Stop reading.
  const audio = new Promise<HTTPResponse | undefined>((resolve) => {
    const seen = (r: HTTPResponse) => {
      if (!r.url().includes("/speech/")) return;
      A.off("response", seen);
      resolve(r);
    };
    A.on("response", seen);
    setTimeout(() => resolve(undefined), 15_000);
  });
  await A.locator('main button[aria-label="Read aloud"]').click();
  const stopShows = await until(A, () => !!document.querySelector('main button[aria-label="Stop reading"]'), undefined, 15_000);
  const mp3 = await audio;
  check(!!mp3 && mp3.status() < 300 && mp3.headers()["content-type"] === "audio/mpeg" && stopShows,
    `Read aloud plays an audio/mpeg file (${mp3?.status() ?? "none"} ${mp3?.headers()["content-type"] ?? ""}) and shows Stop reading`);

  // 4. Dictation: the fake microphone streams to the fake Transcribe; the words land in the box, and the minute
  // reserved at the start comes back down to the seconds spoken.
  await open(A, generalUrl);
  const before = (await room()).budget.spentMicros;
  await A.click('button[aria-label="Dictate"]');
  await until(A, () => !!document.querySelector('button.ml-auto[aria-label="Stop dictating"]:not([disabled])'));
  await sleep(3500);
  await A.click('button.ml-auto[aria-label="Stop dictating"]');
  const typed = await until(A, (t) => (document.querySelector("textarea#composer") as HTMLTextAreaElement).value.includes(t), TRANSCRIPT, 10_000);
  // The 60 s reserved at the start is itself a whole number of seconds, so wait for the settle to bring it under that.
  const spent = (await eventually(room, (r) => {
    const moved = r.budget.spentMicros - before;
    return moved > 0 && moved < 60 * TRANSCRIBE_MICROS_PER_SEC && moved % TRANSCRIBE_MICROS_PER_SEC === 0;
  })).budget.spentMicros - before;
  const seconds = spent / TRANSCRIBE_MICROS_PER_SEC;
  check(typed && Number.isInteger(seconds) && seconds >= 3 && seconds <= 10,
    `dictation types "${TRANSCRIPT}" into the box, and the budget moves by ${spent} µ$ (${seconds} s at 167 µ$/s, after a 60 s reservation)`);
  await A.evaluate(() => {
    const box = document.querySelector("textarea#composer") as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // 5. Push, server side: B's mention of A goes to A's (synthetic) device through the fake sender.
  const ownerId = (await room()).members.find((m) => m.username === owner.name)!.userId;
  const saveDevice = await bff(A, "/bff/api/me/push", "PUT", syntheticSubscription(stamp));
  await open(B, generalUrl);
  await say(B, roomId, general, `@${owner.name} hi`);
  const title = `${guest.name} mentioned you in #general`;
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const pushed = await eventually(async () => (await db.send(new QueryCommand({
    TableName: "cl-local-main", KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
    ExpressionAttributeValues: { ":p": `USER#${ownerId}`, ":s": "PUSHED#" },
  }))).Items ?? [], (items) => items.some((i) => i.note?.title === title), 30_000);
  check(saveDevice.status === 200 && pushed.some((i) => i.note?.title === title), `B's @mention queues a push for A titled "${title}"`);

  // 6. Push, service worker: a delivered push shows its notification, unless a visible tab is already on its page.
  // Headless Chrome keeps no notifications to list, so the worker's showNotification is swapped for a recorder.
  await A.browserContext().overridePermissions(WEB, ["notifications"]);
  const cdp = await A.createCDPSession();
  const registrations = new Map<string, string>();
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: rs }: { registrations: { registrationId: string; scopeURL: string }[] }) => {
    for (const r of rs) registrations.set(r.scopeURL, r.registrationId);
  });
  await cdp.send("ServiceWorker.enable");
  await A.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await eventually(async () => registrations.get(`${WEB}/`), Boolean, 10_000);
  const worker = (await (await A.browserContext().waitForTarget((t) => t.type() === "service_worker")).worker())!;
  await worker.evaluate(() => {
    const sw = self as unknown as { shown: string[]; registration: { showNotification: (title: string) => Promise<void> } };
    sw.shown = [];
    sw.registration.showNotification = async (title) => void sw.shown.push(title);
  });
  const deliver = async (note: { title: string; body: string; url: string; tag: string }) => {
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: WEB, registrationId: registrations.get(`${WEB}/`)!, data: JSON.stringify(note) });
    await sleep(1500);
  };
  await deliver({ title: "smoke elsewhere", body: "media: hi", url: `/r/${roomId}/c/other`, tag: `smoke-a-${stamp}` });
  await deliver({ title: "smoke here", body: "media: hi", url: `/r/${roomId}/c/${general}`, tag: `smoke-b-${stamp}` });
  const shownTitles = await worker.evaluate(() => (self as unknown as { shown: string[] }).shown);
  check(shownTitles.length === 1 && shownTitles[0] === "smoke elsewhere",
    `the service worker shows a push for another page and none for the page that's open (${JSON.stringify(shownTitles)})`);
  await A.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.unregister());
  await cdp.detach();

  // 7. Phone: the dictation strip and the image gallery fit 390 px, and under reduced motion the strip just appears.
  // Motion reads the reduced-motion setting when the page loads, so it is set before the page opens.
  await A.setViewport({ width: 390, height: 844 });
  await A.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await open(A, generalUrl);
  const animated = (await A.evaluate(DICTATION_ROW_FRAMES)) as number;
  await until(A, () => !!document.querySelector('button.ml-auto[aria-label="Stop dictating"]'));
  const stripFits = await noSideScroll(A);
  await A.keyboard.press("Escape");
  await A.emulateMediaFeatures([]);
  await open(A, threadUrl(drew.number));
  await until(A, () => !!document.querySelector('main img[alt^="images/"]'));
  const galleryFits = await noSideScroll(A) && await A.evaluate(() =>
    [...document.querySelectorAll('main img[alt^="images/"]')].every((img) => img.getBoundingClientRect().right <= window.innerWidth));
  check(stripFits && galleryFits && animated === 0,
    `at 390×844 the dictation strip and the gallery fit with no side scroll; reduced motion shows the strip with ${animated} animated frames`);
  await A.setViewport({ width: 1440, height: 900 });
}
