/**
 * Tools and approvals between real browsers, on the fake model and fake GitHub: connecting the fake installation, the
 * approval timeout, a write approved and one denied by another member, the needs-you status and toast, a timeout's
 * skip, the room's activity log, web sources, phone width and motion.
 */
import type { Page } from "puppeteer-core";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readOutputs } from "./deploy-local.js";
import { PANEL, WEB, bff, check, clickButton, eventually, openTab, panelShows, send, socketOpen, until } from "./smoke-page.js";

type Person = { page: Page; name: string };
type Thread = { threadId: string; number: number; status: string; steps: number };

const REPO = "fake-org/playground";
const TITLE = `Comment on #1 in ${REPO}?`;
const RUN_MS = 60_000;

/**
 * Counts the frames in which a pending approval card was still growing or fading in, from the first frame it shows
 * until a second later. The grow is on the second clipping wrapper around the card (the first is the card's own exit). Sent as text because the TypeScript
 * runner wraps named functions in a helper that doesn't exist inside the browser.
 */
const CARD_FRAMES = `new Promise((resolve) => {
  let seen = 0, moving = 0, firstSeen = 0;
  const start = performance.now();
  const sample = (now) => {
    const line = [...document.querySelectorAll("main p")].find((p) => p.textContent.includes("anyone in the room can approve"));
    if (line) {
      seen++;
      firstSeen ||= now;
      const clips = [];
      for (let el = line; el && clips.length < 2; el = el.parentElement) if (el.className === "overflow-hidden") clips.push(el);
      if (clips[1] && Number(getComputedStyle(clips[1]).opacity) < 1) moving++;
    }
    if ((firstSeen && now - firstSeen > 1000) || now - start > 60000) resolve({ seen, moving });
    else requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})`;
type Frames = { seen: number; moving: number };

const mainShows = (page: Page, text: string, timeout = RUN_MS) =>
  until(page, (t) => document.querySelector("main")?.innerText.includes(t), text, timeout);

/**
 * A row of a run that has ended. Once the answer is stored the rows fold into an "N steps" toggle, so a row that was on
 * screen a moment ago is read by opening the newest run's toggle.
 */
async function runRowShows(page: Page, text: string) {
  if (await mainShows(page, text, 2000)) return true;
  await page.evaluate(() => ([...document.querySelectorAll("main button[aria-expanded=false]")] as HTMLElement[])
    .filter((b) => /^\d+ steps?\b/.test(b.textContent ?? "")).at(-1)?.click());
  return mainShows(page, text, 10_000);
}

export async function toolChecks(stamp: number, owner: Person, guest: Person) {
  const A = owner.page;
  const B = guest.page;
  const { roomId, generalChatId: general } = (await bff(A, "/bff/api/rooms", "POST", { name: `tools ${stamp}` })).body as { roomId: string; generalChatId: string };
  const { code } = (await bff(A, `/bff/api/rooms/${roomId}/invite`, "POST", {})).body;
  await bff(B, `/bff/api/invites/${code}/accept`, "POST", {});

  const generalUrl = `${WEB}/r/${roomId}/c/${general}`;
  const threadUrl = (n: number) => `${WEB}/r/${roomId}/t/${n}`;
  const rowOf = (n: number) => `nav[aria-label="Room"] a[href="/r/${roomId}/t/${n}"]`;
  const thread = async (n: number) => ((await bff(A, `/bff/api/rooms/${roomId}`)).body.threads as Thread[]).find((t) => t.number === n)!;
  const ended = (n: number) => eventually(() => thread(n), (t) => t.status !== "running" && t.status !== "waiting");
  const open = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea#composer");
    await socketOpen(page);
  };
  for (const page of [A, B]) {
    await open(page, generalUrl);
    await openTab(page, "Connections");
  }

  // Connect: the owner signs in with the fake GitHub, which sends the browser straight back to the room with the
  // picker open, and picks the fake installation's repo; the member sees the repo and nothing to change it with.
  await A.bringToFront();
  await Promise.all([A.waitForNavigation({ waitUntil: "domcontentloaded" }), clickButton(A, "Connect GitHub")]);
  await A.waitForSelector(`${PANEL} fieldset input[type=checkbox]`);
  await socketOpen(A);
  await A.click(`${PANEL} fieldset input[type=checkbox]`);
  await clickButton(A, "Save");
  const chip = (page: Page) => until(page, (r) => [...document.querySelectorAll('ul[aria-label="Repos"] li')].some((li) => li.textContent === r), REPO);
  const connected = (await chip(A)) && await chip(B);
  const readOnly = await B.evaluate(() => ![...document.querySelectorAll("button")].some((b) => ["Connect GitHub", "Change repos", "Disconnect"].includes(b.textContent?.trim() ?? ""))
    && !document.querySelector('button[aria-label="Change the approval timeout"]'));
  check(connected && readOnly, `A connects the fake installation's ${REPO}; B sees its chip with no Connect, Change repos, Disconnect or timeout button`);

  // The approval timeout, saved by leaving the field.
  await A.click('button[aria-label="Change the approval timeout"]');
  const field = 'input[aria-label="Approval timeout in minutes, 5 to 1440"]';
  await A.waitForSelector(field);
  await A.click(field, { count: 3 });
  await A.keyboard.type("30");
  await A.keyboard.press("Enter");
  const timeoutSet = (await panelShows(A, ["30 min"])) && await panelShows(B, ["30 min"]);
  const logged = await panelShows(B, [`${owner.name} connected ${REPO}`, `${owner.name} set the approval timeout to 30 min`], 15_000);
  check(timeoutSet && logged, "A sets the approval timeout to 30 min; B sees it, and B's Activity lists the connection and the timeout");

  // Approve: B, on #general, sees the thread need someone, opens it from the toast and approves.
  const first = (await bff(A, `/bff/api/rooms/${roomId}/threads`, "POST", { text: "@agent go call:github_comment", clientId: crypto.randomUUID() })).body.thread as Thread;
  const needsYou = await until(B, (row) => document.querySelector(row)?.textContent?.includes("needs you"), rowOf(first.number), RUN_MS);
  const toasted = await until(B, () => [...document.querySelectorAll("[aria-live=polite] button")]
    .some((b) => b.textContent?.includes("needs you") && b.textContent.includes("Comment on #1")));
  check(needsYou && toasted, `while #${first.number} waits, B's sidebar row says "needs you" and a toast names the approval`);
  await B.evaluate(() => ([...document.querySelectorAll("[aria-live=polite] button")] as HTMLElement[]).find((b) => b.textContent?.includes("needs you"))!.click());
  const opened = await until(B, (path) => location.pathname === path, `/r/${roomId}/t/${first.number}`);
  await open(A, threadUrl(first.number));
  const carded = await mainShows(B, "write action · anyone in the room can approve · expires in ");
  await B.bringToFront();
  await clickButton(B, "Approve");
  const mine = await mainShows(B, "Approved by you", 15_000);
  const ran = await ended(first.number);
  const theirs = await runRowShows(A, `Approved by ${guest.name}`);
  check(opened && carded && mine && theirs && ran.status === "done" && ran.steps === 1,
    `the toast opens #${first.number} with the card; B approves: B reads "Approved by you", A "Approved by ${guest.name}", and the run ends ${ran.status} after ${ran.steps} step`);

  // Deny, watched as it happens: the card grows in, it fits a phone, and B's Deny settles it for both.
  await open(B, threadUrl(first.number));
  await B.bringToFront();
  const growing = B.evaluate(CARD_FRAMES) as Promise<Frames>;
  await send(A, "again");
  const grew = await growing;
  const P = await B.browserContext().newPage();
  await P.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await P.goto(threadUrl(first.number), { waitUntil: "domcontentloaded" });
  const fits = await until(P, () => {
    const approve = [...document.querySelectorAll("main button")].find((b) => b.textContent?.trim() === "Approve");
    const title = [...document.querySelectorAll("main p")].find((p) => p.textContent?.startsWith("Comment on #1"));
    const card = approve?.closest('[class*="rounded-[14px]"]')?.getBoundingClientRect();
    return !!card && !!title && card.left >= 0 && card.right <= innerWidth
      && approve!.getBoundingClientRect().top >= title.getBoundingClientRect().bottom
      && document.scrollingElement!.scrollWidth <= innerWidth;
  }, undefined, 30_000);
  const width = await P.evaluate(() => document.scrollingElement!.scrollWidth);
  await P.close();
  check(grew.moving >= 3 && fits, `a new card grows in (${grew.moving} frames in motion), and at 390×844 it fits with its buttons on their own row and no horizontal scroll (${width}px)`);
  await B.bringToFront();
  await clickButton(B, "Deny");
  const mineDenied = await mainShows(B, "Denied by you", 15_000);
  const afterDeny = await ended(first.number);
  const denied = mineDenied && await runRowShows(A, `Denied by ${guest.name}`);
  check(denied && afterDeny.status === "done", `B denies: B reads "Denied by you", A "Denied by ${guest.name}", and the run still finishes`);

  // Timeout: with five seconds set in the table, nobody answers, so the write is skipped with a note. Under reduced
  // motion the card simply appears.
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await db.send(new UpdateCommand({
    TableName: readOutputs("cl-local-core").TableName, Key: { pk: `ROOM#${roomId}`, sk: "META" },
    UpdateExpression: "SET approvalTimeoutSec = :sec", ExpressionAttributeValues: { ":sec": 5 },
  }));
  await B.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await B.bringToFront();
  const appearing = B.evaluate(CARD_FRAMES) as Promise<Frames>;
  await send(A, "once more");
  const still = await appearing;
  await B.emulateMediaFeatures([]);
  check(still.seen > 0 && still.moving === 0, `under reduced motion the card appears at once (${still.moving} of ${still.seen} frames in motion)`);
  const afterSkip = await ended(first.number);
  // The stored answer, not the screen: the thread view links a "#1" in an answer to the room's thread #1.
  const answer = (await bff(A, `/bff/api/rooms/${roomId}/chats/${first.threadId}/messages`)).body.messages.at(-1)?.text as string | undefined;
  const skipped = !!answer?.endsWith(`(Skipped because no one approved in time: ${TITLE})`) && await runRowShows(A, "Skipped: no one approved in time");
  check(skipped && afterSkip.status === "done", `after 5 s with no answer the write is skipped, and the answer ends "(Skipped because no one approved in time: ${TITLE})"`);

  // Activity: who asked, what was approved, denied and skipped, and what the agent ran.
  await openTab(B, "Connections");
  const activity = await panelShows(B, [
    `${owner.name} asked @agent in #${first.number}`, `${guest.name} approved "${TITLE}"`, `${guest.name} denied "${TITLE}"`,
    `No one approved "${TITLE}"`, `@agent ran github_comment in #${first.number}`,
  ], 15_000);
  check(activity, "B's Activity lists the ask, the approval, the denial, the skip and the tool the agent ran");

  // Web sources: a search in a thread with no private content runs without asking, and the panel lists what it read.
  await A.goto(generalUrl, { waitUntil: "domcontentloaded" });
  const search = (await bff(A, `/bff/api/rooms/${roomId}/threads`, "POST", { text: "@agent look it up call:web_search", clientId: crypto.randomUUID() })).body.thread as Thread;
  const searched = await ended(search.number);
  await open(B, threadUrl(search.number));
  await openTab(B, "Context");
  const sources = await until(B, () => {
    const section = [...document.querySelectorAll('aside[aria-label="Room panel"] section')].find((s) => s.querySelector("h2")?.textContent === "Sources");
    return (section?.querySelectorAll("a[href^='http']").length ?? 0) > 0;
  }, undefined, 15_000);
  check(searched.status === "done" && sources, `call:web_search in #${search.number} runs without an approval (${searched.status}), and its Context tab lists the Sources`);
}
