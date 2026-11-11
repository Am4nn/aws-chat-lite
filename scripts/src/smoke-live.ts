/**
 * Live chat between real browsers: delivery, typing, reactions, quotes, edits, deletes, files, the reconnect gap,
 * badges and mute, search, motion, the rate limit, removal, leave, archive and phone width.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, ElementHandle, Page } from "puppeteer-core";
import { WEB, bff, check, grantCreator, person, signUp, sleep, until } from "./smoke-page.js";

type Person = { page: Page; name: string };

const socketOpen = (page: Page) => until(page, () => window.__live?.status === "open", undefined, 12_000);
const shows = (page: Page, text: string, timeout?: number) =>
  until(page, (t) => document.querySelector("main")?.innerText.includes(t), text, timeout);
const toastSays = (page: Page, text: string) =>
  until(page, (t) => document.querySelector("[aria-live=polite]")?.textContent?.includes(t), text);

async function send(page: Page, text: string) {
  await page.click("textarea#composer");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** A send straight over the socket, for messages whose composing isn't what the check is about. */
const say = (page: Page, roomId: string, chatId: string, text: string) =>
  page.evaluate((r, c, t) => window.__live.request("send", { roomId: r, chatId: c, clientId: crypto.randomUUID(), text: t })
    .then(() => "ok", (e: Error) => e.message), roomId, chatId, text);

async function rowWith(page: Page, text: string) {
  const handle = await page.evaluateHandle((t) => [...document.querySelectorAll("main [data-seq]")].reverse().find((el) => (el as HTMLElement).innerText.includes(t)), text);
  return handle.asElement() as ElementHandle<Element>;
}

async function toolbar(page: Page, text: string, label: string) {
  const row = await rowWith(page, text);
  await row.hover();
  await (await row.$(`button[aria-label="${label}"]`))!.click();
  return row;
}

/** The sidebar badges on one chat row as they read on screen: "", "1", "@1" or "@1 2". */
const badgeIs = (page: Page, chat: string, want: string) => until(page, ([n, w]) => {
  const row = [...document.querySelectorAll('nav[aria-label="Room"] li')].find((li) => li.querySelector("a span.truncate")?.textContent === n);
  return !!row && [...row.querySelectorAll("a > span[aria-hidden] > span")]
    .filter((s) => getComputedStyle(s).opacity === "1").map((s) => s.textContent).join(" ") === w;
}, [chat, want]);

async function roomMenu(page: Page, item: string) {
  await page.click('nav[aria-label="Room"] > div button[aria-haspopup="menu"]');
  await page.waitForSelector("[role=menuitem]");
  await page.evaluate((i) => ([...document.querySelectorAll("[role=menuitem]")] as HTMLElement[]).find((x) => x.textContent === i)?.click(), item);
}

async function confirmDialog(page: Page, action: string) {
  await page.waitForSelector("[role=dialog]");
  await sleep(300);
  await page.evaluate((a) => ([...document.querySelectorAll("[role=dialog] button")] as HTMLElement[]).find((x) => x.textContent === a)?.click(), action);
}

/**
 * Samples the newest row containing the marker on every frame for 1.5 s and counts the frames where it was mid-entrance
 * (moved, or partly transparent). Sent as text, like the chat-switch sampler, because the TypeScript runner wraps named
 * functions in a helper that doesn't exist inside the browser.
 */
const entranceFrames = (marker: string) => `new Promise((resolve) => {
  let moving = 0;
  const start = performance.now();
  const sample = () => {
    const row = [...document.querySelectorAll("main [data-key]")].reverse().find((el) => el.innerText.includes(${JSON.stringify(marker)}));
    if (row) {
      const style = getComputedStyle(row);
      const opacity = Number(style.opacity);
      if (!/^(none|matrix\\(1, 0, 0, 1, 0, 0\\))$/.test(style.transform) || (opacity > 0 && opacity < 1)) moving++;
    }
    if (performance.now() - start < 1500) requestAnimationFrame(sample); else resolve(moving);
  };
  requestAnimationFrame(sample);
})`;

async function entrance(viewer: Page, sender: Page, roomId: string, chatId: string, text: string) {
  await viewer.bringToFront();
  const frames = viewer.evaluate(entranceFrames(text)) as Promise<number>;
  await sleep(100);
  await say(sender, roomId, chatId, text);
  return frames;
}

export async function liveChecks(stamp: number, owner: Person, guest: Person, third: Person) {
  const A = owner.page;
  const B = guest.page;
  const roomName = `live ${stamp}`;
  const room = (await bff(A, "/bff/api/rooms", "POST", { name: roomName })).body as { roomId: string; generalChatId: string };
  const { roomId, generalChatId: general } = room;
  const random = (await bff(A, `/bff/api/rooms/${roomId}/chats`, "POST", { name: "random" })).body.chatId as string;
  const side = (await bff(A, "/bff/api/rooms", "POST", { name: `side ${stamp}` })).body as { roomId: string; generalChatId: string };
  const admit = async (p: Page, id: string) => {
    const { code } = (await bff(A, `/bff/api/rooms/${id}/invite`, "POST", {})).body;
    await bff(p, `/bff/api/invites/${code}/accept`, "POST", {});
  };
  await admit(B, roomId);
  await admit(B, side.roomId);
  await admit(third.page, roomId);
  const members = (await bff(A, `/bff/api/rooms/${roomId}`)).body.members as { userId: string; username: string }[];
  const guestId = members.find((m) => m.username === guest.name)!.userId;

  const generalUrl = `${WEB}/r/${roomId}/c/${general}`;
  await A.goto(generalUrl, { waitUntil: "networkidle0" });
  await B.goto(generalUrl, { waitUntil: "networkidle0" });
  check(await socketOpen(A) && await socketOpen(B), "both people's live sockets connect");

  // Delivery: B is already waiting when A presses Enter, so the time measured is the real round trip. The whole
  // username is typed because the people in this room share a prefix, and Enter picks the first match.
  const hello = `hello @${guest.name}`;
  await A.click("textarea#composer");
  await A.keyboard.type(hello);
  await A.waitForSelector("[role=listbox] [role=option]");
  await A.keyboard.press("Enter");
  const arrived = shows(B, hello, 2000);
  const sentAt = Date.now();
  await A.keyboard.press("Enter");
  check(await arrived, `B sees A's "${hello}" live (${Date.now() - sentAt} ms, limit 2000)`);

  await B.click("textarea#composer");
  await B.keyboard.type("thinking");
  check(await shows(A, `${guest.name} is typing…`), "while B types, A sees \"… is typing…\"");
  await B.keyboard.down("Control"); await B.keyboard.press("a"); await B.keyboard.up("Control");
  await B.keyboard.press("Backspace");

  const helloRow = await toolbar(B, hello, "Add reaction");
  await (await helloRow.$('button[aria-label="React thumbs up"]'))!.click();
  check(await until(A, () => [...document.querySelectorAll("main button[aria-pressed]")].some((x) => (x as HTMLElement).innerText.includes("👍") && (x as HTMLElement).innerText.includes("1"))),
    "B reacts 👍 and A sees the chip");

  await toolbar(B, hello, "Reply");
  await B.keyboard.type("got it");
  await B.keyboard.press("Enter");
  check(await until(A, (q) => [...document.querySelectorAll("main [data-seq]")].some((r) =>
    (r as HTMLElement).innerText.includes("got it") && !!r.querySelector("button .lucide-corner-up-left")?.closest("button")?.textContent?.includes(q)), hello),
  "B's quote-reply shows the quoted excerpt");

  await A.click("textarea#composer");
  await A.keyboard.press("ArrowUp");
  await A.keyboard.down("Control"); await A.keyboard.press("a"); await A.keyboard.up("Control");
  await A.keyboard.type("hello everyone");
  await A.keyboard.press("Enter");
  check(await shows(B, "hello everyone") && await shows(B, "(edited)"), "A edits within 15 minutes and B sees \"(edited)\"");

  await send(A, "this one goes away");
  await shows(A, "this one goes away");
  await sleep(300);
  await toolbar(A, "this one goes away", "Delete");
  await A.evaluate(() => ([...document.querySelectorAll("main [role=toolbar] button")] as HTMLElement[]).find((x) => x.innerText === "Delete?")?.click());
  check(await shows(B, "Message deleted"), "A deletes a message and B sees \"Message deleted\"");

  // Files: a screenshot as the image, and an 11 MB file the composer must refuse before uploading anything.
  const dir = mkdtempSync(join(tmpdir(), "cl-smoke-"));
  await B.screenshot({ path: join(dir, "shot.png"), clip: { x: 0, y: 0, width: 400, height: 300 } });
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(11 * 1024 * 1024));
  const input = (await A.$("input[type=file]")) as ElementHandle<HTMLInputElement>;
  await input.uploadFile(join(dir, "shot.png"));
  await until(A, () => document.querySelector('button[aria-label="Remove shot.png"]') && !document.querySelector("main")?.innerText.includes("uploading"), undefined, 10_000);
  await A.click("textarea#composer");
  await A.keyboard.press("Enter");
  check(await until(B, () => {
    const img = document.querySelector('main a[aria-label="Open shot.png"] img') as HTMLImageElement | null;
    return img?.complete && img.naturalWidth > 0;
  }, undefined, 10_000), "an image attachment uploads and shows inline for B");
  await input.uploadFile(join(dir, "big.bin"));
  check(await toastSays(A, "big.bin is over 10 MB.") && !(await A.$('button[aria-label="Remove big.bin"]')), "an 11 MB file is refused in the composer");

  // The reconnect gap: A stays offline until B's message is stored, so only the catch-up fetch can bring it.
  await A.evaluate(() => window.__live.ws.close());
  await until(A, () => window.__live.status !== "open");
  await A.setOfflineMode(true);
  await send(B, "sent while you were away");
  await until(B, () => [...document.querySelectorAll("main [data-seq]")].some((r) => (r as HTMLElement).innerText.includes("sent while you were away")));
  await A.setOfflineMode(false);
  check(await shows(A, "sent while you were away", 15_000), "A's socket is dropped, B sends, and A shows the message after reconnecting");

  // Badges and mute: B reads #general while A writes in #random.
  await say(A, roomId, random, `@${guest.name} are you around?`);
  check(await badgeIs(B, "random", "@1 1"), "B, in another chat, sees a mention badge on #random");
  await B.click(`nav a[href="/r/${roomId}/c/${random}"]`);
  await badgeIs(B, "random", "");
  await sleep(2000);
  await B.click(`nav a[href="/r/${roomId}/c/${general}"]`);
  const randomRow = (await B.evaluateHandle(() => [...document.querySelectorAll('nav[aria-label="Room"] li')]
    .find((li) => li.querySelector("a span.truncate")?.textContent === "random"))).asElement() as ElementHandle<Element>;
  await randomRow.hover();
  await (await randomRow.$("button[aria-haspopup]"))!.click();
  await B.waitForSelector("[role=menuitem]");
  await B.evaluate(() => ([...document.querySelectorAll("[role=menuitem]")] as HTMLElement[]).find((x) => x.textContent === "Mute chat")?.click());
  await toastSays(B, "#random muted");
  await say(A, roomId, random, "nothing urgent");
  await say(A, roomId, random, `@${guest.name} this one is for you`);
  const mutedBadge = await badgeIs(B, "random", "@1");
  await sleep(1000);
  check(mutedBadge && await badgeIs(B, "random", "@1"), "B mutes #random: the unread count hides, but a new mention still shows its badge");

  await A.click('header button[aria-label="Search messages"]');
  await A.waitForSelector('input[aria-label="Search messages"]');
  await A.keyboard.type("hello");
  const found = await until(A, () => [...document.querySelectorAll("aside section button")].some((b) => b.textContent?.includes("hello everyone")));
  await A.evaluate(() => ([...document.querySelectorAll("aside section button")] as HTMLElement[]).find((b) => b.textContent?.includes("hello everyone"))?.click());
  check(found && await until(A, () => [...document.querySelectorAll("main [data-seq]")]
    .some((r) => (r as HTMLElement).innerText.includes("hello everyone") && r.querySelector(":scope > span[aria-hidden]"))),
  "searching \"hello\" finds the message, and clicking it flashes it");

  const rising = await entrance(B, A, roomId, general, "rising in");
  check(rising >= 3, `a new message fades and rises in (${rising} frames in motion)`);
  await B.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  const still = await entrance(B, A, roomId, general, "appearing at once");
  check(still === 0, `with reduced motion a new message appears at once (${still} frames in motion)`);
  await B.emulateMediaFeatures([]);

  // The fixed window counts per epoch minute, so start well inside one; a fresh user has sent nothing in it yet.
  const T = third.page;
  await T.goto(generalUrl, { waitUntil: "networkidle0" });
  await socketOpen(T);
  if (new Date().getSeconds() > 40) await sleep((61 - new Date().getSeconds()) * 1000);
  const acks = await T.evaluate(async (r, c) => {
    const out: string[] = [];
    for (let i = 1; i <= 31; i++) {
      out.push(await window.__live.request("send", { roomId: r, chatId: c, clientId: crypto.randomUUID(), text: `burst ${i}` })
        .then(() => "ok", (e: Error) => e.message));
    }
    return out;
  }, roomId, random);
  check(acks.slice(0, 30).every((a) => a === "ok") && /Slow down/.test(acks[30]), `the 31st send within a minute is refused ("${acks[30]}")`);

  // Removal: B keeps the same socket (B lands in the side room), and it must stop hearing this room.
  await B.evaluate(() => { window.__seen = []; window.__live.on("message.new", (e) => window.__seen.push(e.message.roomId)); });
  await bff(A, `/bff/api/rooms/${roomId}/members/${guestId}`, "DELETE", {});
  const told = await toastSays(B, `You're no longer in ${roomName}`);
  const moved = await until(B, (id) => location.pathname.startsWith(`/r/${id}/`), side.roomId, 10_000);
  check(told && moved, "the owner removes B: B is told and leaves the room");
  await say(A, roomId, general, "not for removed members");
  await say(A, side.roomId, side.generalChatId, "still here in the side room");
  await shows(B, "still here in the side room");
  const seen = await B.evaluate(() => window.__seen);
  const refused = await say(B, roomId, general, "let me back in");
  check(seen.includes(side.roomId) && !seen.includes(roomId) && refused !== "ok",
    `B's open socket gets no more of the room's messages, and its sends there are refused ("${refused}")`);

  await roomMenu(T, "Leave room");
  await confirmDialog(T, "Leave room");
  check(await until(T, () => document.body.innerText.includes("No rooms yet"), undefined, 10_000), "a third member leaves the room and lands on the empty home");

  await roomMenu(A, "Archive room");
  await confirmDialog(A, "Archive room");
  await until(A, (id) => !location.pathname.startsWith(`/r/${id}`), roomId, 10_000);
  await A.click('nav[aria-label="Room"] > div button[aria-haspopup="menu"]');
  await A.waitForSelector("[role=menu]");
  const listed = await A.evaluate((n) => [...document.querySelectorAll("[role=menu] a")].some((a) => a.textContent?.includes(n)), roomName);
  await A.keyboard.press("Escape");
  await A.goto(generalUrl, { waitUntil: "networkidle0" });
  check(!listed && await shows(A, "This room is archived."), "the owner archives the room: it leaves the switcher and its composer says \"This room is archived.\"");

  const P = await A.browserContext().newPage();
  await P.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await P.goto(`${WEB}/r/${side.roomId}/c/${side.generalChatId}`, { waitUntil: "networkidle0" });
  await P.waitForSelector("textarea#composer");
  const layout = () => P.evaluate(() => ({
    scroll: document.scrollingElement!.scrollWidth,
    width: innerWidth,
    height: innerHeight,
    navRight: document.querySelector('nav[aria-label="Room"]')!.getBoundingClientRect().right,
    composerBottom: document.querySelector("textarea#composer")!.getBoundingClientRect().bottom,
  }));
  const closed = await layout();
  await P.click('header button[aria-label="Open sidebar"]');
  await sleep(500);
  const open = await layout();
  check(closed.scroll <= closed.width && closed.composerBottom <= closed.height && closed.navRight <= 0 && open.navRight > 200,
    `at 390×844: no horizontal scroll (${closed.scroll}px), the composer is on screen, and the menu button opens the drawer`);
  await P.close();
}

/** A creator with no rooms yet creates one from the home page and must land in it with the socket connected. */
export async function emptyHomeCheck(browser: Browser, username: string) {
  const page = await person(browser);
  await signUp(page, username);
  await grantCreator(page, username);
  await page.goto(WEB, { waitUntil: "networkidle0" });
  await page.type("#room-name", "first room");
  await page.click("button[type=submit]");
  check(await until(page, () => /^\/r\/[^/]+\/c\//.test(location.pathname) && window.__live?.status === "open", undefined, 15_000),
    "creating a room from the empty home opens it with the live socket connected");
}
