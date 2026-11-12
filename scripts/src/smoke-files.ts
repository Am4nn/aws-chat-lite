/**
 * Room files between real browsers: an upload and its replacement, a file an agent's sandbox step saves, a delete,
 * the sandbox internet switch, the Files tab at phone width, and the slide-in of a fresh row.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElementHandle, Page } from "puppeteer-core";
import { PANEL, WEB, bff, check, confirmDialog, eventually, sampleFrames, socketOpen, until } from "./smoke-page.js";

type Person = { page: Page; name: string };
type Thread = { threadId: string; number: number; status: string };

/** Counts the frames in which a freshly changed file row was still sliding or fading in, until a second after it shows. */
const FRESH_ROW_FRAMES = (path: string) => sampleFrames({
  vars: "let seen = 0, moving = 0, firstSeen = 0;",
  perFrame: `const row = [...document.querySelectorAll('${PANEL} li')].find((li) => li.querySelector("span[title]")?.title === ${JSON.stringify(path)});
    if (row) {
      seen++;
      firstSeen ||= now;
      if (!placed(row)) moving++;
    }`,
  done: "(firstSeen && now - firstSeen > 1000) || now - start > 15000",
  result: "{ seen, moving }",
});

/** Whether the panel lists `path`, and its row's text includes `meta` when given. */
const fileShows = (page: Page, path: string, meta = "", timeout?: number) =>
  until(page, ([p, m]) => {
    const row = [...document.querySelectorAll('aside[aria-label="Room panel"] li')].find((li) => li.querySelector("span[title]")?.getAttribute("title") === p);
    return !!row && !!row.textContent?.includes(m);
  }, [path, meta], timeout);

const fileGone = (page: Page, path: string) =>
  until(page, (p) => ![...document.querySelectorAll('aside[aria-label="Room panel"] span[title]')].some((s) => s.getAttribute("title") === p), path);

async function openFilesTab(page: Page) {
  await page.waitForSelector(`${PANEL} [role=tab]`);
  await page.evaluate(() => ([...document.querySelectorAll('aside[aria-label="Room panel"] [role=tab]')] as HTMLElement[])
    .find((t) => t.getAttribute("aria-label")?.startsWith("Files"))!.click());
  await page.waitForSelector(`${PANEL} input[type=file]`);
}

/** Picks a file in the panel's Upload input, as the file dialog would. */
async function pickFile(page: Page, file: string) {
  const input = (await page.$(`${PANEL} input[type=file]`)) as ElementHandle<HTMLInputElement>;
  await input.uploadFile(file);
}

/**
 * An upload through the files API from inside the page (presign, POST to S3, commit), for setup that isn't under test.
 * No named functions inside: the TypeScript runner would wrap them in a helper the browser doesn't have.
 */
const uploadText = (page: Page, roomId: string, path: string, text: string) =>
  page.evaluate(async (r, p, t) => {
    const base = `/bff/api/rooms/${r}/files`;
    const headers = { "content-type": "application/json" };
    const form = await fetch(`${base}/uploads`, { method: "POST", headers, body: JSON.stringify({ path: p, size: t.length, type: "text/plain" }) }).then((res) => res.json());
    const body = new FormData();
    for (const [k, v] of Object.entries(form.fields as Record<string, string>)) body.append(k, v);
    body.append("file", new Blob([t], { type: "text/plain" }));
    await fetch(form.url, { method: "POST", body });
    await fetch(base, { method: "PUT", headers, body: JSON.stringify({ path: p, uploadKey: form.uploadKey }) });
  }, roomId, path, text);

export async function fileChecks(stamp: number, owner: Person, guest: Person) {
  const A = owner.page;
  const B = guest.page;
  const { roomId } = (await bff(A, "/bff/api/rooms", "POST", { name: `files ${stamp}` })).body as { roomId: string };
  const { code } = (await bff(A, `/bff/api/rooms/${roomId}/invite`, "POST", {})).body;
  await bff(B, `/bff/api/invites/${code}/accept`, "POST", {});
  const roomUrl = `${WEB}/r/${roomId}`;
  for (const page of [A, B]) {
    await page.goto(roomUrl, { waitUntil: "networkidle0" });
    await socketOpen(page);
    await openFilesTab(page);
  }
  const dir = mkdtempSync(join(tmpdir(), "cl-smoke-"));
  // Each pick gets its own folder, since the second notes.txt must keep the first one's name.
  const local = (name: string, text: string) => {
    const sub = mkdtempSync(join(dir, "f-"));
    writeFileSync(join(sub, name), text);
    return join(sub, name);
  };

  // Upload, then a second upload of the same name, which asks before replacing.
  await A.bringToFront();
  await pickFile(A, local("notes.txt", "hello\n"));
  const arrived = await fileShows(B, "notes.txt", `6 B · @${owner.name}`);
  await fileShows(A, "notes.txt");
  await pickFile(A, local("notes.txt", "hello, twenty bytes\n"));
  const asked = await until(A, () => document.querySelector("[role=dialog]")?.getAttribute("aria-label") === "Replace notes.txt?");
  await confirmDialog(A, "Replace");
  const replaced = await fileShows(B, "notes.txt", `20 B · @${owner.name}`);
  check(arrived && asked && replaced, `A's upload of notes.txt reaches B by @${owner.name}, and a second one asks "Replace notes.txt?" and brings B the new size`);

  // An agent's sandbox step saves a file into the room, credited to its thread.
  const thread = (await bff(A, `/bff/api/rooms/${roomId}/threads`, "POST", { text: "make sh`echo hi > hi.txt`", clientId: crypto.randomUUID() })).body.thread as Thread;
  const saved = await fileShows(B, "hi.txt", `3 B · #${thread.number}`, 60_000);
  await eventually(async () => ((await bff(A, `/bff/api/rooms/${roomId}`)).body.threads as Thread[]).find((t) => t.number === thread.number)!,
    (t) => t.status !== "running");
  const { url } = (await bff(A, `/bff/api/rooms/${roomId}/files/download?path=hi.txt`)).body as { url: string };
  const content = await fetch(url).then((r) => r.text());
  check(saved && content === "hi\n", `sh\`echo hi > hi.txt\` in thread #${thread.number} shows hi.txt live by #${thread.number}, and its download is "hi\\n" (${JSON.stringify(content)})`);

  // Any member deletes, behind a confirm.
  await B.bringToFront();
  await B.evaluate(() => (document.querySelector('button[aria-label="Delete hi.txt"]') as HTMLElement).click());
  const confirm = await until(B, () => document.querySelector("[role=dialog]")?.getAttribute("aria-label") === "Delete hi.txt?");
  await confirmDialog(B, "Delete");
  check(confirm && await fileGone(A, "hi.txt"), "B deletes hi.txt after a confirm, and it's gone for A");

  // The internet switch: a member sees the setting, only an owner or admin moves it.
  const internetText = (page: Page, value: string) =>
    until(page, (v) => !document.querySelector('[role=switch][aria-label="Sandbox internet"]')
      && [...document.querySelectorAll('aside[aria-label="Room panel"] span.font-mono')].some((s) => s.textContent === v), value);
  const offForB = await internetText(B, "off");
  const flip = async (on: boolean) => {
    await A.click('[role=switch][aria-label="Sandbox internet"]');
    return until(A, (v) => document.querySelector('[role=switch][aria-label="Sandbox internet"]')?.getAttribute("aria-checked") === v, String(on));
  };
  const turnedOn = (await flip(true)) && await internetText(B, "on");
  const turnedOff = (await flip(false)) && await internetText(B, "off");
  const stored = (await bff(A, `/bff/api/rooms/${roomId}`)).body.sandboxInternet;
  check(offForB && turnedOn && turnedOff && stored === false,
    `B sees the sandbox internet "off" with no switch; A turns it on (B sees "on") and off again (stored ${stored})`);

  // Phone width: the Files tab in the overlay, and its confirm, fit the screen.
  const P = await B.browserContext().newPage();
  await P.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await P.goto(roomUrl, { waitUntil: "networkidle0" });
  await P.click('button[aria-label="Toggle room panel"]');
  await openFilesTab(P);
  const onScreen = (selector: string) => until(P, (sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return document.scrollingElement!.scrollWidth <= innerWidth && !!r && r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
  }, selector);
  const listed = (await fileShows(P, "notes.txt")) && await onScreen('button[aria-label="Delete notes.txt"]');
  await P.tap('button[aria-label="Delete notes.txt"]');
  const dialogFits = await onScreen("[role=dialog]");
  await confirmDialog(P, "Cancel");
  const kept = await fileShows(P, "notes.txt");
  const width = await P.evaluate(() => document.scrollingElement!.scrollWidth);
  check(listed && dialogFits && kept, `at 390×844 the Files tab works in the overlay: the list, its Delete and the confirm are on screen, with no horizontal scroll (${width}px)`);
  await P.close();

  // A file that arrives slides in, and under reduced motion it simply appears.
  await B.bringToFront();
  const sliding = B.evaluate(FRESH_ROW_FRAMES("motion.txt")) as Promise<{ seen: number; moving: number }>;
  await uploadText(A, roomId, "motion.txt", "m");
  const slid = await sliding;
  await B.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await B.bringToFront();
  const appearing = B.evaluate(FRESH_ROW_FRAMES("still.txt")) as Promise<{ seen: number; moving: number }>;
  await uploadText(A, roomId, "still.txt", "s");
  const still = await appearing;
  await B.emulateMediaFeatures([]);
  check(slid.moving >= 3 && still.seen > 0 && still.moving === 0,
    `a fresh file row slides in (${slid.moving} frames in motion), and under reduced motion it appears at once (${still.moving} of ${still.seen})`);
}
