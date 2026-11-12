/**
 * Agent threads between real browsers, on the fake model: the in-place card, the thread view, the sidebar, steering,
 * Stop by another member, a stream resumed after a drop, rename, tag delivery, the budget, archiving, numbering, phone
 * width and motion.
 */
import type { HTTPRequest, Page } from "puppeteer-core";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readOutputs } from "./cdk.js";
import { flociHost } from "./env.js";
import { clsFrom, gapless, streamedExactly } from "./smoke-helpers.js";
import { IDENTITY, WEB, bff, check, eventually, sampleFrames, send, shows, socketOpen, toastSays, until } from "./smoke-page.js";

type Person = { page: Page; name: string };
type Thread = { threadId: string; number: number; name: string; status: string; steps: number; runFirstSeq?: number };
type Message = { seq: number; text: string; authorName: string; agent?: { status: string; runId: string } };

declare global {
  interface Window {
    __card?: Element; __rowLive?: string; __stopSampling?: boolean; __runStream: { drop(): void };
    __cards(): Element[]; __doneSteps(): HTMLElement[]; __archived(): Element | undefined;
  }
}

const RUN_MS = 60_000;

/**
 * Lookups the checks share inside the page, installed as text on every page load for the same reason as `sampleFrames`.
 * A card is the box around an "Open" link to its thread.
 */
const PAGE_HELPERS = `
window.__cards = () => [...document.querySelectorAll("main a")].filter((a) => a.textContent.trim() === "Open")
  .map((a) => a.closest('[class*="rounded-[14px]"]'));
window.__doneSteps = () => [...document.querySelectorAll("main button")].filter((b) => b.querySelector(".sr-only")?.textContent === ", done");
window.__archived = () => [...document.querySelectorAll("[cmdk-group]")]
  .find((g) => g.querySelector("[cmdk-group-heading]")?.textContent === "Archived");
`;

/**
 * Samples the streaming answer on every frame. It counts the frames where a word was still fading in, and the frames
 * where a `shimmer` text was animating. With `untilStopped` it also records each new version of the answer's text and
 * runs until the test sets `__stopSampling`; otherwise it ends 1.5 s after the first words show.
 */
const answerFrames = (untilStopped: boolean) => sampleFrames({
  vars: "const texts = []; let seen = 0, moving = 0, shimmers = 0, shimmering = 0, firstSeen = 0;",
  perFrame: `const words = [...document.querySelectorAll('main span[class*="animate-[word-in"]')];
    if (words.length) {
      seen++;
      firstSeen ||= now;
      if (words.some((w) => !placed(w) || getComputedStyle(w).filter !== "none")) moving++;
    }
    const shimmer = [...document.querySelectorAll(".shimmer")];
    shimmers += shimmer.length;
    shimmering += shimmer.filter((el) => getComputedStyle(el).animationName !== "none").length;
    const answer = [...document.querySelectorAll("main h2")].find((h) => h.textContent.startsWith("Fake answer for"));
    const text = answer ? answer.parentElement.innerText : "";
    if (text && text !== texts.at(-1)) texts.push(text);`,
  done: `(${untilStopped} ? window.__stopSampling : firstSeen && now - firstSeen > 1500) || now - start > 90000`,
  result: "{ texts, seen, moving, shimmers, shimmering }",
});
type Frames = { texts: string[]; seen: number; moving: number; shimmers: number; shimmering: number };

/**
 * Opens the first card's thread and reports the most composers on screen in any frame, sampled from before the click
 * until the thread's page has been up for a second. More than one means a second copy of a view was mounted.
 */
const OPEN_CARD_AND_COUNT_VIEWS = sampleFrames({
  vars: "let most = 0, arrived = 0;",
  perFrame: `most = Math.max(most, document.querySelectorAll("main textarea#composer").length);
    if (location.pathname.includes("/t/")) arrived ||= now;`,
  done: "(arrived && now - arrived > 1000) || now - start > 15000",
  result: "most",
  begin: `window.__cards()[0].querySelector("a").click();`,
});

export async function threadChecks(stamp: number, owner: Person, guest: Person) {
  const A = owner.page;
  const B = guest.page;
  const { roomId, generalChatId: general } = (await bff(A, "/bff/api/rooms", "POST", { name: `agents ${stamp}` })).body as { roomId: string; generalChatId: string };
  const { code } = (await bff(A, `/bff/api/rooms/${roomId}/invite`, "POST", {})).body;
  await bff(B, `/bff/api/invites/${code}/accept`, "POST", {});

  const threadUrl = (n: number) => `${WEB}/r/${roomId}/t/${n}`;
  const rowOf = (n: number) => `nav[aria-label="Room"] a[href="/r/${roomId}/t/${n}"]`;
  const threads = async () => (await bff(A, `/bff/api/rooms/${roomId}`)).body.threads as Thread[];
  const thread = async (n: number) => (await threads()).find((t) => t.number === n)!;
  const settled = (n: number) => eventually(() => thread(n), (t) => t.status !== "running");
  const history = async (chatId: string) => (await bff(A, `/bff/api/rooms/${roomId}/chats/${chatId}/messages`)).body.messages as Message[];
  const start = async (text: string) =>
    (await bff(A, `/bff/api/rooms/${roomId}/threads`, "POST", { text, clientId: crypto.randomUUID() })).body.thread as Thread;
  // A live run keeps its stream open, so the network never goes idle on its page; wait for the socket instead, and
  // for the server view the page refetches once the socket opens: read before a change made meanwhile, it would land
  // after it and show the old state.
  const open = async (page: Page, n: number) => {
    const refreshed = new Promise<void>((resolve) => {
      const onFinished = (r: HTTPRequest) => {
        if (r.headers().rsc !== "1" || !r.url().includes(`/t/${n}`)) return;
        page.off("requestfinished", onFinished);
        resolve();
      };
      page.on("requestfinished", onFinished);
      setTimeout(() => { page.off("requestfinished", onFinished); resolve(); }, 15_000);
    });
    await page.goto(threadUrl(n), { waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea#composer");
    await socketOpen(page);
    await refreshed;
  };

  await A.evaluateOnNewDocument(PAGE_HELPERS);
  await B.evaluateOnNewDocument(PAGE_HELPERS);
  const generalUrl = `${WEB}/r/${roomId}/c/${general}`;
  await A.goto(generalUrl, { waitUntil: "networkidle0" });
  await B.goto(generalUrl, { waitUntil: "networkidle0" });
  await socketOpen(A);
  await socketOpen(B);

  // The card and the sidebar: B watches while A asks in #general.
  await send(A, "@agent check PR 41 tools:2");
  const running = await until(B, (row) => {
    const card = window.__cards()[0];
    const meta = document.querySelector(`${row} span.font-mono`)?.textContent ?? "";
    if (!window.__rowLive && document.querySelector(`${row} svg[class*="animate-[spin"]`) && /^step \d+ · \d+:\d\d$/.test(meta)) window.__rowLive = meta;
    if (card?.querySelector('svg[class*="animate-[spin"]') && /step \d+ · \d+:\d\d/.test(card.textContent ?? "")) window.__card = card;
    return !!window.__card && !!window.__rowLive;
  }, rowOf(1), 30_000);
  const done = await until(B, () => !!window.__card?.isConnected && !!window.__card.querySelector("svg.text-sky")
    && !window.__card.querySelector('svg[class*="animate-[spin"]'), undefined, RUN_MS);
  const cards = await B.evaluate(() => window.__cards().length);
  const posted = (await history(general)).length;
  check(running && done && cards === 1 && posted === 1,
    `B sees one card go from running to ✓ in place, and #general gained exactly 1 message (${cards} card, ${posted} message)`);
  const rowLive = await B.evaluate(() => window.__rowLive);
  const finishedAt = await until(B, (row) => /^\d\d:\d\d$/.test(document.querySelector(`${row} span.font-mono`)?.textContent ?? ""), rowOf(1));
  check(!!rowLive && finishedAt, `B's sidebar row shows the spinner and "${rowLive}" while it runs, then the time it ended`);

  // The thread view, opened from the card.
  await A.bringToFront();
  const views = (await A.evaluate(OPEN_CARD_AND_COUNT_VIEWS)) as number;
  const titled = await until(A, (path) => location.pathname === path
    && /#1.*check-pr-41/.test(document.querySelector("main header h1")?.textContent ?? ""), `/r/${roomId}/t/1`);
  const folded = await until(A, () => [...document.querySelectorAll("main button")].filter((b) => b.textContent === "2 steps")
    .map((b) => b.getAttribute("aria-expanded")).join() === "false" && !document.querySelector("main pre"));
  await A.evaluate(() => ([...document.querySelectorAll("main button")] as HTMLElement[]).find((b) => b.textContent === "2 steps")!.click());
  const expanded = await until(A, () => window.__doneSteps().length === 2);
  await A.evaluate(() => window.__doneSteps()[0].click());
  const output = await until(A, () => document.querySelector("main pre")?.textContent?.includes("Found 3 notes"));
  const headline = await A.evaluate(() => [...document.querySelectorAll("main h2")].some((h) => h.textContent?.startsWith("Fake answer for")));
  check(views === 1 && titled && folded && expanded && output && headline,
    `the card opens #1 check-pr-41 as one view (at most ${views} on screen): its 2 steps fold into "▸ 2 steps", expanding shows "Found 3 notes", and the headline reads "Fake answer for…"`);

  // Rename: A renames in the header while B watches #general.
  const rename = async (name: string) => {
    await A.click('button[title="Rename thread"]');
    await A.waitForSelector('input[aria-label="Thread name"]');
    await A.keyboard.down("Control"); await A.keyboard.press("a"); await A.keyboard.up("Control");
    await A.keyboard.type(name);
    await A.keyboard.press("Enter");
  };
  await rename("pr-review");
  const renamed = await until(B, (row) => !!window.__cards()[0]?.textContent?.includes("pr-review")
    && !!document.querySelector(row)?.textContent?.includes("pr-review"), rowOf(1));
  await rename("general");
  const taken = await toastSays(A, "#general is taken.");
  // The title ends with the thread agent's label, so the name is read from the name button.
  const kept = await until(A, () => document.querySelector('button[title="Rename thread"]')?.textContent?.endsWith("pr-review"));
  check(renamed && taken && kept, "renaming to pr-review updates B's card and sidebar; renaming to general shows the 409 toast and keeps the name");

  // Tag delivery: a leading #tag in #general hands the message to the thread.
  await A.click(`nav a[href="/r/${roomId}/c/${general}"]`);
  await until(A, (path) => location.pathname === path && !!document.querySelector("textarea#composer"), `/r/${roomId}/c/${general}`);
  await send(A, "#pr-review also docs");
  const chip = await until(A, () => [...document.querySelectorAll("main a")].some((a) => a.textContent === "→ #pr-review"), undefined, 15_000);
  const first = await thread(1);
  const copy = await eventually(() => history(first.threadId), (ms) => ms.some((m) => m.text.endsWith("also docs") && m.authorName === owner.name), 10_000);
  const copySeq = copy.find((m) => m.text.endsWith("also docs"))?.seq;
  const rerun = await eventually(() => thread(1), (t) => t.runFirstSeq === copySeq, 10_000);
  check(chip && copySeq !== undefined && rerun.runFirstSeq === copySeq,
    `"#pr-review also docs" in #general lands in the thread (seq ${copySeq}), starts a run there, and shows the → #pr-review chip`);
  await settled(1);

  // Steering: B sends while a slow step runs, so the agent reads it between steps and takes one more. Opening a page
  // can take longer than a whole run, so both are open before the run under test starts: the thread's first run only
  // sets the directives (the fake model reads them from the thread's first message), and A's follow-up starts it.
  const steer = await start("steer test slow tools:2 words:3");
  await open(A, steer.number);
  await open(B, steer.number);
  await settled(steer.number);
  await send(A, "go on");
  const stepping = await until(B, () => [...document.querySelectorAll("main .sr-only")].some((s) => s.textContent === ", running"), undefined, 30_000);
  await send(B, "also check PR 43");
  const bubble = await until(A, (name) => [...document.querySelectorAll("main b")].some((b) => b.textContent === name
    && b.parentElement?.textContent?.includes("also check PR 43")), guest.name, 15_000);
  const steered = await eventually(() => thread(steer.number), (t) => t.status !== "running" && (t.runFirstSeq ?? 0) > 1);
  const toggle = await until(A, () => [...document.querySelectorAll("main button")].some((b) => b.textContent === "3 steps · 1 steer"), undefined, 15_000);
  check(stepping && bubble && steered.status === "done" && steered.steps === 3 && toggle,
    `B steers "also check PR 43" mid-run: A sees the steer bubble, and the run ends ${steered.status} with ${steered.steps} steps`);

  // Stop by a member who didn't start the run, watched under reduced motion.
  const stop = await start("stop test slow words:400");
  await B.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await open(A, stop.number);
  await open(B, stop.number);
  await B.bringToFront();
  const still = (await B.evaluate(answerFrames(false))) as Frames;
  check(still.seen > 0 && still.moving === 0 && still.shimmers > 0 && still.shimmering === 0,
    `with reduced motion the answer's words appear at once (${still.moving} of ${still.seen} frames in motion) and nothing shimmers (${still.shimmering} animating)`);
  await B.click('button[aria-label="Stop the run"]');
  const stopClicked = Date.now();
  const stoppedShown = await until(A, (text) => document.querySelector("main")?.innerText.includes(text), `Stopped by ${guest.name}.`, 10_000);
  const stopMs = Date.now() - stopClicked;
  const partial = (await eventually(() => history(stop.threadId), (ms) => ms.some((m) => m.agent), 10_000)).find((m) => m.agent);
  const kept400 = !!partial && partial.agent!.status === "stopped" && partial.text.startsWith("Fake answer for") && partial.text.split(/\s+/).length < 400;
  check(stoppedShown && stopMs <= 3000 && kept400 && await shows(A, "Fake answer for"),
    `B stops A's run: "Stopped by ${guest.name}." in ${stopMs} ms (limit 3000), with the partial answer kept (${partial?.text.split(/\s+/).length ?? 0} words)`);
  await B.emulateMediaFeatures([]);

  // Resume: the stream is cut mid-answer and must pick up where it left off, with every word once.
  const resume = await start("resume test slow tools:0 words:60");
  const resumes: string[] = [];
  let cut = false;
  const onRequest = (req: { url(): string; method(): string; headers(): Record<string, string> }) => {
    if (cut && req.method() === "GET" && req.url().includes("/stream?ticket=")) resumes.push(req.headers()["last-event-id"] ?? "");
  };
  A.on("request", onRequest);
  await open(A, resume.number);
  await A.bringToFront();
  const sampling = A.evaluate(answerFrames(true)) as Promise<Frames>;
  await until(A, () => document.querySelectorAll('main span[class*="animate-[word-in"]').length >= 10, undefined, 30_000);
  cut = true;
  await A.evaluate(() => window.__runStream.drop());
  await settled(resume.number);
  const answer = (await eventually(() => history(resume.threadId), (ms) => ms.some((m) => m.agent), 10_000)).find((m) => m.agent)!;
  await until(A, () => [...document.querySelectorAll("main p")].some((p) => /^\S+ · \$\d+\.\d\d · \d+:\d\d$/.test(p.textContent ?? "")), undefined, 10_000);
  await until(A, () => !document.querySelector('main span[class*="animate-[word-in"]'));
  await A.evaluate(() => { window.__stopSampling = true; });
  const live = await sampling;
  A.off("request", onRequest);
  check(resumes.length > 0 && Number(resumes[0]) > 0, `after window.__runStream.drop() the next stream request carries Last-Event-ID (${resumes[0] || "none"})`);
  check(!!answer && streamedExactly(live.texts, answer.text), `the resumed answer on screen equals the stored one, word for word (${live.texts.length} samples)`);
  check(live.moving >= 5, `the answer's words fade in as they arrive (${live.moving} frames in motion)`);

  // Budget: only the owner sets it, and at $0 the next run stops before its first model call.
  check((await bff(B, `/bff/api/rooms/${roomId}/budget`, "PUT", { capUsd: 5 })).status === 403, "a member can't set the room budget (403)");
  const setCap = async (usd: string) => {
    await A.click('button[aria-label="Change the monthly cap"]');
    await A.waitForSelector('input[aria-label^="Monthly cap"]');
    await A.keyboard.down("Control"); await A.keyboard.press("a"); await A.keyboard.up("Control");
    await A.keyboard.type(usd);
    await A.keyboard.press("Enter");
    return until(A, () => !document.querySelector('input[aria-label^="Monthly cap"]'));
  };
  await setCap("0");
  const capped = await start("budget test tools:0");
  await open(A, capped.number);
  const budgetEnd = await until(A, () => document.querySelector("main header [role=status]")?.textContent?.includes("Budget reached")
    && document.querySelector("main")?.innerText.includes("This room has used its $0.00 budget")
    && (document.querySelector("span.bg-amber") as HTMLElement | null)?.style.width === "100%", undefined, 30_000);
  check(budgetEnd, "with the cap at $0 the next run ends \"Budget reached\" with the budget text and a full amber bar");
  await setCap("3");
  const reset = await eventually(async () => (await bff(A, `/bff/api/rooms/${roomId}`)).body.budget.capMicros as number, (c) => c === 3_000_000, 5000);
  check(reset === 3_000_000 && await until(A, () => document.body.textContent?.includes("/$3.00")), "the owner sets the cap back to $3");

  // Archive: a thread idle for 8 days is computed as archived, and a message reopens it.
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  await db.send(new UpdateCommand({
    TableName: readOutputs("cl-local-core").TableName,
    Key: { pk: `ROOM#${roomId}`, sk: `THREAD#${String(capped.number).padStart(10, "0")}` },
    UpdateExpression: "SET lastActivityAt = :at",
    ExpressionAttributeValues: { ":at": new Date(Date.now() - 8 * 86_400_000).toISOString() },
  }));
  await A.reload({ waitUntil: "networkidle0" });
  const hidden = await until(A, ([gone, kept]) => !document.querySelector(gone) && !!document.querySelector(kept), [rowOf(capped.number), rowOf(1)]);
  const label = `#${capped.number} ${(await thread(capped.number)).name}`;
  await A.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await A.keyboard.down("Control"); await A.keyboard.press("k"); await A.keyboard.up("Control");
  await A.waitForSelector("[cmdk-input]");
  await A.keyboard.type(label.split(" ")[1]);
  const found = await until(A, (text) => [...(window.__archived()?.querySelectorAll("[cmdk-item]") ?? [])].some((i) => i.textContent?.includes(text)), label);
  await A.evaluate(() => (window.__archived()?.querySelector("[cmdk-item]") as HTMLElement | null)?.click());
  // The palette fades out over the page; until it's gone it takes the clicks meant for the composer.
  await until(A, (path) => location.pathname === path && !!document.querySelector("textarea#composer") && !document.querySelector("[cmdk-root]"),
    `/r/${roomId}/t/${capped.number}`);
  await send(A, "back again");
  const reopened = await until(A, (row) => !!document.querySelector(row), rowOf(capped.number), 15_000);
  check(hidden && found && reopened,
    `a thread idle for 8 days leaves the sidebar (${hidden}), Ctrl K finds it under Archived as ${label} (${found}), and sending reopens it (${reopened})`);
  await settled(capped.number);

  // Phone width while a run works.
  const phoneThread = await start("phone test slow tools:2");
  const P = await A.browserContext().newPage();
  await P.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await open(P, phoneThread.number);
  const fits = await until(P, () => document.scrollingElement!.scrollWidth <= innerWidth
    && [document.querySelector("main header [role=status]"), document.querySelector('button[aria-label="Stop the run"]')].every((el) => {
      const r = el?.getBoundingClientRect();
      return !!r && r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    }), undefined, 20_000);
  const width = await P.evaluate(() => document.scrollingElement!.scrollWidth);
  check(fits, `at 390×844 during a run: no horizontal scroll (${width}px), and the run capsule and Stop are on screen`);
  await P.click('button[aria-label="Stop the run"]');
  await settled(phoneThread.number);
  await P.close();

  // Switching threads moves nothing out of place.
  await open(A, 1);
  await A.evaluate(() => {
    (window as unknown as { __shifts: unknown[] }).__shifts = [];
    new PerformanceObserver((list) => (window as unknown as { __shifts: unknown[] }).__shifts.push(...list.getEntries()))
      .observe({ type: "layout-shift", buffered: false });
  });
  for (const n of [steer.number, 1, steer.number]) {
    await A.click(rowOf(n));
    await until(A, ([path, identity]) => location.pathname === path
      && [...document.querySelectorAll("main > div > div")].every((p) => new RegExp(identity).test(getComputedStyle(p).transform))
      && document.getAnimations().every((a) => a.effect?.getComputedTiming().iterations === Infinity), [`/r/${roomId}/t/${n}`, IDENTITY]);
  }
  const shifts = await A.evaluate(() =>
    (window as unknown as { __shifts: { value: number; hadRecentInput: boolean }[] }).__shifts.map((e) => ({ value: e.value, hadRecentInput: e.hadRecentInput })));
  const cls = clsFrom(shifts);
  check(cls < 0.02, `switching threads doesn't shift the layout (CLS ${cls.toFixed(3)})`);

  // Numbering: five threads created at once take distinct numbers with no hole. Floci starts a fresh threads and run
  // container for each concurrent call, so one call in a burst can outlast the BFF's 8 s deadline, which is a budget
  // for a person waiting, not for the counter judged here. So these calls go straight to the API, with API Gateway's
  // own 30 s integration ceiling as their deadline. A retry would be wrong: each POST makes a new thread.
  const before = Math.max(...(await threads()).map((t) => t.number));
  const idToken = (await A.browserContext().cookies()).find((c) => c.name === "cl_id")!.value;
  const api = `http://${flociHost(readOutputs("cl-local-core").ApiUrl)}`;
  const numbers = await Promise.all([1, 2, 3, 4, 5].map(async (i) => {
    const res = await fetch(`${api}/rooms/${roomId}/threads`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: `count ${i} tools:0 words:1`, clientId: crypto.randomUUID() }),
    });
    return ((await res.json()) as { thread?: { number: number } }).thread?.number ?? 0;
  }));
  check(gapless(numbers) && Math.min(...numbers) === before + 1, `5 threads created at once get distinct, gapless numbers (${numbers.join(", ")})`);
  await eventually(threads, (ts) => ts.every((t) => t.status !== "running"));
}
