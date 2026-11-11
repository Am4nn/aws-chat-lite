/**
 * The model picker between real browsers, on the fake model: the pill and its keyboard menu, Auto's routing, the
 * room default, private threads, phone width and motion.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElementHandle, Page } from "puppeteer-core";
import { WEB, bff, check, send, sleep, socketOpen, toastSays, until } from "./smoke-page.js";

type Person = { page: Page; name: string };
type Thread = { threadId: string; number: number; status: string };

const RUN_MS = 60_000;
const PILL = 'main button[aria-label^="Model:"]';
const LOCK = '[aria-label="Private: has attachments, so DeepSeek is off."]';
/** A computed transform that leaves the element where it is. */
const IDENTITY = "^(none|matrix\\(1, 0, 0, 1, 0, 0\\))$";

/**
 * Opens the model menu and counts the frames, over 600 ms, where it was still fading or moving in. Sent as text, like
 * the other samplers, because the TypeScript runner wraps named functions in a helper that doesn't exist in the page.
 */
const OPEN_MENU_AND_COUNT_FRAMES = `new Promise((resolve) => {
  let moving = 0;
  const start = performance.now();
  const sample = (now) => {
    const menu = document.querySelector("main [role=menu]");
    if (menu) {
      const s = getComputedStyle(menu);
      if (Number(s.opacity) < 1 || !new RegExp(${JSON.stringify(IDENTITY)}).test(s.transform)) moving++;
    }
    if (now - start > 600) resolve(moving); else requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  document.querySelector(${JSON.stringify(PILL)}).click();
})`;

/** The pill unlocks once the page hears the run ended, a moment after the API says so. */
const pillReady = (page: Page) => until(page, (sel) => !document.querySelector(sel)?.hasAttribute("aria-disabled"), PILL);
const pillSays = (page: Page, label: string) => until(page, ([sel, l]) => document.querySelector(sel)?.getAttribute("aria-label") === `Model: ${l}`, [PILL, label]);
/** The footer under the newest answer. */
const footer = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll("main p.font-mono")].map((p) => p.textContent ?? "").filter((t) => t.includes(" · ")).at(-1) ?? "");
const footerMatches = (page: Page, pattern: RegExp) =>
  until(page, (source) => new RegExp(source).test([...document.querySelectorAll("main p.font-mono")]
    .map((p) => p.textContent ?? "").filter((t) => t.includes(" · ")).at(-1) ?? ""), pattern.source, RUN_MS);
const menuItem = (page: Page, label: string) =>
  page.evaluate((l) => ([...document.querySelectorAll("[role=menuitemradio]")] as HTMLElement[]).find((b) => b.textContent?.startsWith(l))?.click(), label);
const closeMenu = async (page: Page) => {
  await page.keyboard.press("Escape");
  await until(page, () => !document.querySelector("main [role=menu]"));
};

export async function modelChecks(stamp: number, owner: Person, guest: Person) {
  const A = owner.page;
  const B = guest.page;
  const { roomId, generalChatId: general } = (await bff(A, "/bff/api/rooms", "POST", { name: `models ${stamp}` })).body as { roomId: string; generalChatId: string };
  const { code } = (await bff(A, `/bff/api/rooms/${roomId}/invite`, "POST", {})).body;
  await bff(B, `/bff/api/invites/${code}/accept`, "POST", {});

  const thread = async (n: number) => ((await bff(A, `/bff/api/rooms/${roomId}`)).body.threads as Thread[]).find((t) => t.number === n)!;
  const settled = async (n: number) => {
    const end = Date.now() + RUN_MS;
    while ((await thread(n)).status === "running" && Date.now() < end) await sleep(500);
  };
  const start = async (text: string) =>
    (await bff(A, `/bff/api/rooms/${roomId}/threads`, "POST", { text, clientId: crypto.randomUUID() })).body.thread as Thread;
  const open = async (page: Page, n: number) => {
    await page.goto(`${WEB}/r/${roomId}/t/${n}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(PILL);
    await socketOpen(page);
  };
  const dir = mkdtempSync(join(tmpdir(), "cl-smoke-"));
  writeFileSync(join(dir, "notes.txt"), "private notes");
  const attach = async (page: Page) => {
    await ((await page.$("input[type=file]")) as ElementHandle<HTMLInputElement>).uploadFile(join(dir, "notes.txt"));
    await until(page, () => !!document.querySelector('main [aria-label^="Remove"]') || !![...document.querySelectorAll("main")].some((m) => m.textContent?.includes("notes.txt")));
    await sleep(1000);
  };

  // The pill, by keyboard: a thread starts on Auto, and Haiku picked from the menu answers the next message.
  const picked = await start("models tools:0 words:3");
  await open(A, picked.number);
  await settled(picked.number);
  const startsAuto = await pillSays(A, "Auto");
  await pillReady(A);
  await A.focus(PILL);
  await A.keyboard.press("Enter");
  await A.waitForSelector("[role=menu]");
  await A.keyboard.press("ArrowDown");
  await A.keyboard.press("ArrowDown");
  await A.keyboard.press("Enter");
  const haiku = await pillSays(A, "Haiku 5.5");
  await send(A, "tools:0 hi");
  const answered = await footerMatches(A, /^Haiku 5\.5 · <?\$\d+\.\d\d · \d+:\d\d$/);
  check(startsAuto && haiku && answered, `the pill starts on Auto; Haiku picked with the keyboard answers the next message ("${await footer(A)}")`);
  await settled(picked.number);

  // Auto routes with the fake router: Sonnet by default, Haiku when the first message says route:haiku.
  const sonnetRun = await start("@agent hello tools:0 words:5");
  await open(A, sonnetRun.number);
  const toSonnet = await footerMatches(A, /^Auto → Sonnet 5\.5 · /);
  const haikuRun = await start("route:haiku hey tools:0 words:3");
  await open(A, haikuRun.number);
  const toHaiku = await footerMatches(A, /^Auto → Haiku 5\.5 · /);
  check(toSonnet && toHaiku, "Auto answers on Sonnet (\"Auto → Sonnet 5.5\"), and on Haiku when the router says haiku (\"Auto → Haiku 5.5\")");

  // The room default: the owner makes Opus the default and the member's pill follows; members can't set it.
  await open(B, haikuRun.number);
  await pillReady(A);
  await A.click(PILL);
  await A.waitForSelector("[role=menu]");
  await menuItem(A, "Opus 5.5");
  await pillReady(A);
  await A.click(PILL);
  await A.waitForSelector("[role=menu]");
  await A.evaluate(() => ([...document.querySelectorAll("main [role=menu] button")] as HTMLElement[])
    .find((b) => b.textContent === "Make Opus 5.5 the room default")?.click());
  const followed = await pillSays(B, "Opus 5.5");
  await pillReady(B);
  await B.click(PILL);
  await B.waitForSelector("[role=menu]");
  const noDefault = await B.evaluate(() => !document.querySelector("main [role=menu]")?.textContent?.includes("the room default"));
  await closeMenu(B);
  await bff(A, `/bff/api/rooms/${roomId}/model`, "PUT", { model: "auto" });
  const reset = await pillSays(B, "Auto");
  check(followed && noDefault && reset, "the owner makes Opus the room default and the member's pill shows Opus 5.5; the member's menu can't set a default");

  // Private: a file makes the thread private for everyone, and DeepSeek can't be picked for it.
  const secret = await start("private tools:0 words:3");
  await open(A, secret.number);
  await open(B, secret.number);
  await settled(secret.number);
  await attach(A);
  await send(A, "see the file");
  const locked = await until(B, (sel) => !!document.querySelector(sel), LOCK, 15_000);
  await settled(secret.number);
  await until(B, (sel) => document.querySelector(sel)?.getAttribute("aria-disabled") !== "true", PILL);
  await pillReady(B);
  await B.click(PILL);
  await B.waitForSelector("[role=menu]");
  const dimmed = await B.evaluate(() => ([...document.querySelectorAll("[role=menuitemradio]")] as HTMLElement[])
    .filter((b) => b.textContent?.startsWith("DeepSeek")).map((b) => b.getAttribute("aria-disabled")).join());
  await closeMenu(B);
  check(locked && dimmed === "true,true", `a file sent into a thread shows the member its lock, and both DeepSeek rows are disabled (${dimmed})`);

  // A DeepSeek room default on that private thread: the member who never picked sees Auto, and a send runs on Auto.
  await bff(A, `/bff/api/rooms/${roomId}/model`, "PUT", { model: "deepseek-flash" });
  await sleep(1000);
  const showsAuto = await pillSays(B, "Auto");
  const answersBefore = await B.evaluate(() => [...document.querySelectorAll("main p.font-mono")].filter((p) => p.textContent?.includes(" · ")).length);
  await send(B, "and now?");
  const ranOnAuto = await until(B, ([n, source]) => {
    const footers = [...document.querySelectorAll("main p.font-mono")].map((p) => p.textContent ?? "").filter((t) => t.includes(" · "));
    return footers.length > n && new RegExp(source).test(footers.at(-1)!);
  }, [answersBefore, /^Auto → Sonnet 5\.5 · \S+ · /.source] as const, RUN_MS);
  await settled(secret.number);
  await bff(A, `/bff/api/rooms/${roomId}/model`, "PUT", { model: "auto" });
  check(showsAuto && ranOnAuto, `with DeepSeek the room default, the private thread's pill shows Auto and a member's send runs on Auto ("${await footer(B)}")`);

  // DeepSeek picked first, then a file and @agent in a people chat: the server refuses the pick before storing anything.
  await A.goto(`${WEB}/r/${roomId}/c/${general}`, { waitUntil: "networkidle0" });
  await socketOpen(A);
  await pillReady(A);
  await A.click(PILL);
  await A.waitForSelector("[role=menu]");
  await menuItem(A, "DeepSeek Flash");
  await attach(A);
  await send(A, "@agent read this");
  const refused = await toastSays(A, "so DeepSeek is off here. Pick another model.");
  check(refused, "a DeepSeek pick sent with a file to @agent is refused with the privacy message");

  // Phone width: the short label, and a menu that fits the screen.
  const P = await A.browserContext().newPage();
  await P.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await P.goto(`${WEB}/r/${roomId}/c/${general}`, { waitUntil: "networkidle0" });
  await P.waitForSelector(PILL);
  await pillReady(P);
  await P.click(PILL);
  await P.waitForSelector("[role=menu]");
  await menuItem(P, "DeepSeek Flash");
  const short = await pillSays(P, "DS Flash");
  await pillReady(P);
  await P.click(PILL);
  await P.waitForSelector("[role=menu]");
  await sleep(400);
  const fits = await P.evaluate(() => {
    const r = document.querySelector("main [role=menu]")!.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && document.scrollingElement!.scrollWidth <= innerWidth;
  });
  check(short && fits, "at 390×844 the pill reads DS Flash, and its open menu fits the screen with no horizontal scroll");
  await P.close();

  // Motion: the menu eases in, and appears at once under reduced motion.
  await A.goto(`${WEB}/r/${roomId}/c/${general}`, { waitUntil: "networkidle0" });
  await A.waitForSelector(PILL);
  const moving = (await A.evaluate(OPEN_MENU_AND_COUNT_FRAMES)) as number;
  await closeMenu(A);
  await A.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await A.goto(`${WEB}/r/${roomId}/c/${general}`, { waitUntil: "networkidle0" });
  await A.waitForSelector(PILL);
  const still = (await A.evaluate(OPEN_MENU_AND_COUNT_FRAMES)) as number;
  await closeMenu(A);
  await A.emulateMediaFeatures([]);
  check(moving >= 3 && still === 0, `the model menu eases in (${moving} frames in motion), and with reduced motion it appears at once (${still})`);
}
