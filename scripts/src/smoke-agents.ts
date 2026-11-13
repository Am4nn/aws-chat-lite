/**
 * Room agents, helpers, memory and schedules between real browsers, on the fake model: an agent made in the panel, a
 * mention that picks it, a helper's collapsed step and its lane on the Map, memory saved by a tool and edited by a
 * member, a schedule fired on demand, a copy to another room, phone width and motion.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Page } from "puppeteer-core";
import {
  PANEL, WEB, bff, check, clickButton, eventually, openTab, panelShows, sampleFrames, say, socketOpen, toastSays, until,
} from "./smoke-page.js";

type Person = { page: Page; name: string };
type Thread = { threadId: string; number: number; name: string; status: string; agentId: string };
type Agent = { agentId: string; name: string };
type Schedule = { scheduleId: string; title: string; enabled: boolean };

const RUN_MS = 60_000;
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true };
/** A step card on the Map: a button in an absolutely placed wrapper (the time and cost figures are pressed buttons too). */
const CARD = "main div[style*=left] > button";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Presses the newest turn's Replay on the Map and counts, for 2 s, the frames in which a card's wrapper was not yet opaque and in place. */
const REPLAY_FRAMES = sampleFrames({
  vars: "let moving = 0;",
  perFrame: `if ([...document.querySelectorAll(${JSON.stringify(CARD)})].some((b) => !placed(b.parentElement))) moving++;`,
  done: "now - start >= 2000",
  result: "moving",
  begin: `document.querySelector('main button[aria-label="Replay this turn"]').click();`,
});

/** Counts the frames, until `text`'s memory row has shown for a second, in which that row was still sliding in. */
const memoryFrames = (text: string) => sampleFrames({
  vars: "let moving = 0, firstSeen = 0;",
  perFrame: `const row = document.querySelector(${JSON.stringify(`li[aria-label="${text}"]`)});
    if (row) {
      firstSeen ||= now;
      if (!placed(row)) moving++;
    }`,
  done: "(firstSeen && now - firstSeen > 1000) || now - start > 60000",
  result: "moving",
});

export async function agentChecks(stamp: number, owner: Person, guest: Person) {
  const A = owner.page;
  const B = guest.page;
  const name = `agents ${stamp}`;
  const other = `agents two ${stamp}`;
  const { roomId, generalChatId: general } = (await bff(A, "/bff/api/rooms", "POST", { name })).body as { roomId: string; generalChatId: string };
  const second = (await bff(A, "/bff/api/rooms", "POST", { name: other })).body as { roomId: string };
  const { code } = (await bff(A, `/bff/api/rooms/${roomId}/invite`, "POST", {})).body;
  await bff(B, `/bff/api/invites/${code}/accept`, "POST", {});

  const generalUrl = `${WEB}/r/${roomId}/c/${general}`;
  const threadUrl = (n: number) => `${WEB}/r/${roomId}/t/${n}`;
  const threads = async () => (await bff(A, `/bff/api/rooms/${roomId}`)).body.threads as Thread[];
  const ended = (n: number) => eventually(threads, (ts) => ["done", "failed", "stopped"].includes(ts.find((t) => t.number === n)?.status ?? ""), RUN_MS);
  const ask = async (text: string) =>
    (await bff(A, `/bff/api/rooms/${roomId}/threads`, "POST", { text, clientId: crypto.randomUUID() })).body.thread as Thread;
  const answer = async (t: Thread) =>
    ((await bff(A, `/bff/api/rooms/${roomId}/chats/${t.threadId}/messages`)).body.messages as { text: string }[]).at(-1)?.text ?? "";
  const open = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea#composer");
    await socketOpen(page);
  };
  for (const page of [A, B]) {
    await open(page, generalUrl);
    await openTab(page, "Agents");
  }

  // Agents: A makes @researcher with the web only; B sees it, but nothing to edit or delete it with.
  await A.bringToFront();
  await A.locator('button[aria-label="New agent"]').click();
  await A.waitForSelector("#agent-name-new");
  await A.type("#agent-name-new", "researcher");
  await A.type("#agent-instructions-new", "Find sources and cite them.");
  for (const kind of ["sandbox", "images"]) {
    if (await A.$eval(`#agent-new-${kind}`, (el) => (el as HTMLInputElement).checked)) await A.click(`#agent-new-${kind}`);
  }
  await clickButton(A, "Create agent");
  const listed = (await panelShows(A, ["@researcher", `by ${owner.name}`])) && await panelShows(B, ["@researcher"], 15_000);
  const menu = `${PANEL} button[aria-label="Actions for @researcher"]`;
  let items: string[] = [];
  if (await B.$(menu)) {
    await B.click(menu);
    items = await B.$$eval("[role=menuitem]", (els) => els.map((e) => e.textContent?.trim() ?? ""));
    await B.keyboard.press("Escape");
  }
  // A, its creator, edits it from its menu.
  await A.click(menu);
  await clickButton(A, "Edit");
  const instructions = '[id^="agent-instructions-"]';
  await A.waitForSelector(instructions);
  await A.click(instructions, { count: 3 });
  await A.keyboard.type("Find sources, cite them, keep it short.");
  await clickButton(A, "Save");
  const agents = await eventually(async () => (await bff(A, `/bff/api/rooms/${roomId}/agents`)).body.agents as (Agent & { tools: string[]; instructions: string })[],
    (list) => list.some((a) => a.instructions.endsWith("keep it short.")), 15_000);
  const researcher = agents.find((a) => a.name === "researcher")!;
  check(listed && !items.includes("Edit") && !items.includes("Delete") && researcher?.tools.join() === "web" && researcher.instructions.endsWith("keep it short."),
    `A creates @researcher (web) in the Agents panel and edits it; B sees it with no Edit or Delete (${items.join(", ") || "no menu"})`);

  // Mention: B's message names @researcher, so the thread it starts is @researcher's, on its card and in the sidebar.
  await B.bringToFront();
  await say(B, roomId, general, "@researcher go");
  const mentioned = await eventually(threads, (ts) => ts.some((t) => t.agentId === researcher.agentId));
  const byMention = mentioned.find((t) => t.agentId === researcher.agentId);
  const carded = !!byMention && await until(B, () => [...document.querySelectorAll("main a")].filter((a) => a.textContent?.trim() === "Open")
    .some((a) => a.closest('[class*="rounded-[14px]"]')?.textContent?.includes("@researcher")), undefined, 15_000);
  const sidebar = !!byMention && await until(B, (href) => document.querySelector(`nav[aria-label="Room"] a[href="${href}"]`)?.textContent?.includes("@researcher"),
    `/r/${roomId}/t/${byMention.number}`);
  check(carded && sidebar, `B's "@researcher go" starts #${byMention?.number} as @researcher: its card and its sidebar row read @researcher`);
  if (byMention) await ended(byMention.number);

  // Helper: @agent hands the task to @researcher, whose work is one collapsed step with its own two steps inside.
  const helped = await ask("@agent ask:researcher");
  await ended(helped.number);
  await open(A, threadUrl(helped.number));
  await A.evaluate(() => ([...document.querySelectorAll("main button[aria-expanded=false]")] as HTMLElement[])
    .filter((b) => /^\d+ steps?\b/.test(b.textContent ?? "")).at(-1)?.click());
  const delegateRow = 'main button[aria-expanded]';
  const collapsed = await until(A, (sel) => [...document.querySelectorAll(sel)].some((b) => b.textContent?.includes("Asked @researcher")), delegateRow, 15_000);
  await A.evaluate((sel) => ([...document.querySelectorAll(sel)] as HTMLElement[]).find((b) => b.textContent?.includes("Asked @researcher"))!.click(), delegateRow);
  const inner = await until(A, () => {
    const row = ([...document.querySelectorAll("main button[aria-expanded=true]")] as HTMLElement[]).find((b) => b.textContent?.includes("Asked @researcher"));
    return row?.parentElement?.querySelectorAll("[aria-label='Helper steps'] > div > button").length === 2;
  });
  check(collapsed && inner, `"@agent ask:researcher" (#${helped.number}) shows one collapsed researcher step that opens onto the helper's 2 steps`);

  // Map: the helper's lane named under its first card, sky hand-off edges, cards that drop in on Replay, and a card's
  // details with its tokens and cost.
  await A.goto(`${threadUrl(helped.number)}?view=map`, { waitUntil: "domcontentloaded" });
  await A.waitForSelector(CARD);
  const lanes = await A.$$eval("main span[style*=left]", (els) => els.map((e) => e.textContent));
  const sky = await A.$$eval('main svg path[stroke="#7CC7FF"]', (els) => els.length);
  await A.bringToFront();
  const dropping = await A.evaluate(REPLAY_FRAMES) as number;
  await A.evaluate((card) => ([...document.querySelectorAll(card)] as HTMLElement[])
    .find((b) => b.textContent?.includes("fake.lookup"))?.click(), CARD);
  const tile = (label: string) => A.evaluate((l) => [...document.querySelectorAll('aside[aria-label="Room panel"] dt')]
    .find((dt) => dt.textContent === l)?.nextElementSibling?.textContent ?? "", label);
  await panelShows(A, ["tokens", "cost"]);
  const [tokens, cost] = [await tile("tokens"), await tile("cost")];
  check(lanes.join() === "researcher helper" && sky >= 2 && dropping >= 3 && tokens !== "—" && !!tokens && cost.startsWith("$"),
    `the Map names the helper's lane (${lanes.join(" | ")}), shows ${sky} sky hand-off edges and cards dropping in on Replay (${dropping} frames); a card's details show tokens ${tokens} and cost ${cost}`);

  // Reduced motion: Replay draws the cards in place. Motion reads the preference when the page loads.
  await A.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await A.reload({ waitUntil: "domcontentloaded" });
  await A.waitForSelector(CARD);
  const still = await A.evaluate(REPLAY_FRAMES) as number;
  await A.emulateMediaFeatures([]);
  check(still === 0, `under reduced motion the Map's Replay moves nothing (${still} frames)`);

  // Phone: the Map scrolls inside its own box, the page never sideways; the panel's tabs and its grouped tabs fit.
  const P = await A.browserContext().newPage();
  await P.setViewport(PHONE);
  await P.goto(`${threadUrl(helped.number)}?view=map`, { waitUntil: "domcontentloaded" });
  await P.waitForSelector(CARD);
  const box = await P.evaluate(() => {
    const scroller = document.querySelector("main .overflow-auto.overscroll-contain")!;
    return { page: document.scrollingElement!.scrollWidth, inner: innerWidth, map: scroller.scrollWidth, shown: scroller.clientWidth };
  });
  // Picking a card opens the panel over the Map, with the Step tab first.
  await P.locator(CARD).click();
  let fits = true;
  for (const tab of ["Agents", "Room"]) {
    await openTab(P, tab);
    fits &&= await until(P, () => {
      const panel = document.querySelector('aside[aria-label="Room panel"]')!.getBoundingClientRect();
      return panel.left >= 0 && panel.right <= innerWidth && document.scrollingElement!.scrollWidth <= innerWidth;
    });
  }
  const tabs = await P.$$eval(`${PANEL} [role=tab]`, (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  const tablist = await P.$eval(`${PANEL} [role=tablist]`, (el) => el.scrollWidth <= el.clientWidth);
  await P.close();
  check(box.page <= box.inner && box.map > box.shown && fits && tablist && Math.min(...tabs) >= 24,
    `at 390×844 the Map scrolls in its box (${box.map}px in ${box.shown}px) with no page scroll (${box.page}px); Agents and Room fit; the ${tabs.length} tabs fit, narrowest ${Math.min(...tabs)}px`);

  // Memory: a tool saves an entry, which slides into A's panel; B edits it; the next run reads the edit.
  await open(A, generalUrl);
  await openTab(A, "Agents");
  await A.bringToFront();
  const sliding = A.evaluate(memoryFrames("fake")) as Promise<number>;
  const saved = await ask("@agent call:memory_save");
  await ended(saved.number);
  const slid = await sliding;
  await openTab(B, "Agents");
  await B.bringToFront();
  await B.waitForSelector(`${PANEL} li[aria-label="fake"] button[aria-label="Edit memory"]`);
  await B.click(`${PANEL} li[aria-label="fake"] button[aria-label="Edit memory"]`);
  await B.waitForSelector(`${PANEL} textarea[aria-label="Memory"]`);
  await B.click(`${PANEL} textarea[aria-label="Memory"]`, { count: 3 });
  await B.keyboard.type("We ship on Fridays.");
  await clickButton(B, "Save");
  const edited = await panelShows(A, ["We ship on Fridays.", `edited by ${guest.name}`], 15_000);
  const recall = await ask("@agent recall");
  await ended(recall.number);
  const recalled = (await answer(recall)).includes("We ship on Fridays.");
  check(slid >= 3 && edited && recalled, `call:memory_save's entry slides into the Memory panel (${slid} frames); B edits it, A sees the edit, and "@agent recall" answers with it`);

  // Schedule: a daily 09:00 for @researcher in #general, fired on demand, opens a card and a dated thread.
  await openTab(A, "Agents");
  await A.locator('button[aria-label="New schedule"]').click();
  await A.waitForSelector("#schedule-title-new");
  await A.type("#schedule-title-new", "Morning digest");
  await A.select("#schedule-agent-new", researcher.agentId);
  await A.type("#schedule-prompt-new", "Summarise the day.");
  await clickButton(A, "Create schedule");
  const row = await until(A, () => {
    const text = document.querySelector('aside[aria-label="Room panel"]')?.textContent ?? "";
    return text.includes("Morning digest") && text.includes("Every day at 09:00") && /next \w{3} 09:00/.test(text);
  }, undefined, 15_000);
  // Switched off and on again from its row: the server follows each press.
  const scheduled = async () => ((await bff(A, `/bff/api/rooms/${roomId}/schedules`)).body.schedules as Schedule[]).find((s) => s.title === "Morning digest");
  const toggle = `${PANEL} button[role=switch][aria-label="Morning digest on"]`;
  await A.click(toggle);
  const off = await eventually(scheduled, (s) => s?.enabled === false, 15_000);
  await A.click(toggle);
  const schedule = await eventually(scheduled, (s) => s?.enabled === true, 15_000);
  const toggled = off?.enabled === false && schedule?.enabled === true;
  const fire = schedule && spawnSync("npm", ["run", "schedule:fire", "--", roomId, schedule.scheduleId], { cwd: repoRoot, shell: true, encoding: "utf8" });
  const fired = !!fire && fire.status === 0 && fire.stdout.includes("Fired: started");
  const day = new Date().toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "Asia/Kolkata" }).toLowerCase().replace(" ", "-");
  const digest = await eventually(threads, (ts) => ts.some((t) => t.name === `morning-digest-${day}`), 15_000);
  const dated = digest.find((t) => t.name === `morning-digest-${day}`);
  const card = !!dated && await until(A, (n) => [...document.querySelectorAll("main a")].filter((a) => a.textContent?.trim() === "Open")
    .some((a) => a.closest('[class*="rounded-[14px]"]')?.textContent?.includes(`#${n}`)), dated.name, 15_000);
  check(row && toggled && fired && !!dated && card,
    `"Morning digest" reads "Every day at 09:00 · next … 09:00" and switches off and on; schedule:fire opens its card in #general and the thread ${dated?.name ?? `morning-digest-${day} (missing)`}`);

  // Copy: @researcher goes to A's other room with its schedule switched off.
  await openTab(A, "Agents");
  await A.waitForSelector(menu);
  await A.click(menu);
  await clickButton(A, `Copy to ${other}`);
  const toasted = await toastSays(A, `Copied to ${other} as @researcher · 1 schedule copied, off`);
  const copies = (await bff(A, `/bff/api/rooms/${second.roomId}/agents`)).body.agents as Agent[];
  const copied = copies.find((a) => a.name === "researcher");
  const theirs = (await bff(A, `/bff/api/rooms/${second.roomId}/schedules`)).body.schedules as (Schedule & { agentId: string })[];
  check(toasted && !!copied && theirs.length === 1 && !theirs[0]!.enabled && theirs[0]!.agentId === copied?.agentId,
    `A copies @researcher to "${other}": the toast says so, and that room lists @researcher with its schedule off`);

  // Room powers: A switches the room to Auto; B's header says so at once, and @herald's post lands in #fake with no card.
  const fake = (await bff(A, `/bff/api/rooms/${roomId}/chats`, "POST", { name: "fake" })).body as { chatId: string };
  await bff(A, `/bff/api/rooms/${roomId}/agents`, "POST", { name: "herald", instructions: "Post what you are asked to.", tools: ["room_post"] });
  await bff(A, `/bff/api/rooms/${roomId}/approval-mode`, "PUT", { mode: "auto" });
  const badge = await until(B, () => document.querySelector('header [role="img"][title^="Auto:"]')?.textContent?.trim() === "Auto", undefined, 10_000);
  check(badge, "A switches the room to Auto: B's header shows the Auto badge within 10 s, with no reload");

  const posting = await ask("@herald call:room_post");
  let waited = false;
  const postRun = await eventually(threads, (ts) => {
    const status = ts.find((t) => t.number === posting.number)?.status;
    waited ||= status === "waiting";
    return ["done", "failed", "stopped"].includes(status ?? "");
  }, RUN_MS);
  const posted = ((await bff(A, `/bff/api/rooms/${roomId}/chats/${fake.chatId}/messages`)).body.messages as
    { authorId: string; authorName: string; text: string; agentPost?: { number: number } }[]).at(-1);
  await open(B, `${WEB}/r/${roomId}/c/${fake.chatId}`);
  // The thread is named after its first answer, so the link reads the name it has now, not the one it started with.
  const named = await eventually(threads, (ts) => ts.find((t) => t.number === posting.number)?.name !== posting.name, 15_000);
  const rowShown = await until(B, (link) => {
    const a = [...document.querySelectorAll("main a")].find((el) => el.textContent?.trim() === link);
    return !!a && !!a.parentElement?.textContent?.includes("AI");
  }, `from #${named.find((t) => t.number === posting.number)?.name}`, 15_000);
  check(postRun.find((t) => t.number === posting.number)?.status === "done" && !waited && posted?.authorId === "agent" && posted.authorName === "herald"
    && posted.agentPost?.number === posting.number && posted.text === "fake" && rowShown,
  `@herald call:room_post in Auto ends done with no approval; #fake's last message is herald's "fake" from #${posting.number}, and B sees it with the AI tag and "from #<its thread>" `
    + `(run ${postRun.find((t) => t.number === posting.number)?.status}, waited ${waited}, last ${JSON.stringify(posted && { by: posted.authorName, text: posted.text, from: posted.agentPost?.number })}, row ${rowShown})`);
  await bff(A, `/bff/api/rooms/${roomId}/approval-mode`, "PUT", { mode: "ask" });
}
