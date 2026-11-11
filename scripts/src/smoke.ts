/**
 * End-to-end check of the running app (Floci + `npm run dev`): sign-up, the creators group, rooms, invites, roles,
 * the API's 403s, httpOnly cookies, the motion rules (no layout shift, no movement under reduced motion), then the
 * live chat between real browsers, then agent threads and the model picker on the fake model, then room files and the sandbox,
 * then tools and approvals on fake GitHub, then MCP both ways against the local test server.
 */
import puppeteer, { type Page } from "puppeteer-core";
import { useLocalEnv } from "./env.js";
import { clsFrom } from "./smoke-helpers.js";
import { WEB, bff, check, grantCreator, person, results, signUp, toastSays } from "./smoke-page.js";
import { emptyHomeCheck, liveChecks } from "./smoke-live.js";
import { modelChecks } from "./smoke-models.js";
import { threadChecks } from "./smoke-threads.js";
import { fileChecks } from "./smoke-files.js";
import { toolChecks } from "./smoke-tools.js";
import { mcpChecks } from "./smoke-mcp.js";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

/**
 * Clicks the second chat and records the main content's on-screen transform on every frame for 800 ms. Sampling starts
 * before the click, inside the page, so no frame of the transition is missed. Motion animates transforms from
 * JavaScript, so the browser's own animation list can't show them; the rendered style can. The script is sent as text
 * because the TypeScript runner wraps named functions in a helper that doesn't exist inside the browser.
 */
const SWITCH_AND_SAMPLE = `new Promise((resolve) => {
  const frames = [];
  const start = performance.now();
  const sample = () => {
    const offset = [...document.querySelectorAll("main > div > div")]
      .some((panel) => !/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(getComputedStyle(panel).transform));
    frames.push(offset);
    if (performance.now() - start < 800) requestAnimationFrame(sample); else resolve(frames.filter(Boolean).length);
  };
  requestAnimationFrame(sample);
  document.querySelectorAll("nav[aria-label=Room] ul a")[1].click();
})`;

/** Loads the room fresh on its first chat, switches to the second, and counts the frames where content was offset. */
async function offsetFrames(page: Page, roomUrl: string): Promise<number> {
  await page.goto(roomUrl, { waitUntil: "networkidle0" });
  return (await page.evaluate(SWITCH_AND_SAMPLE)) as number;
}

async function main() {
  useLocalEnv();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const stamp = Date.now() % 1_000_000;
  const [owner, guest, late, newcomer] = [`s${stamp}a`, `s${stamp}b`, `s${stamp}c`, `s${stamp}d`];
  try {
    const ownerPage = await person(browser);
    const guestPage = await person(browser);
    await signUp(ownerPage, owner);
    await signUp(guestPage, guest);

    await grantCreator(ownerPage, owner);
    const reserved = await bff(await person(browser), "/bff/auth/signup", "POST", { username: "everyone", password: "password1" });
    check(reserved.status === 400 && reserved.body.error === "That username is reserved.", "the username \"everyone\" is refused at sign-up");

    check((await bff(guestPage, "/bff/api/rooms", "POST", { name: "nope" })).status === 403, "a non-creator can't create a room (403)");
    const room = await bff(ownerPage, "/bff/api/rooms", "POST", { name: `smoke ${stamp}` });
    check(room.status === 201, "a creator creates a room");
    const roomId = room.body.roomId as string;

    check((await bff(guestPage, `/bff/api/rooms/${roomId}`)).status === 404, "a non-member can't see the room (404)");
    const invite = await bff(ownerPage, `/bff/api/rooms/${roomId}/invite`, "POST", {});
    check((await bff(guestPage, `/bff/api/invites/${invite.body.code}/accept`, "POST", {})).status === 200, "the guest joins through the invite");
    check((await bff(guestPage, `/bff/api/rooms/${roomId}/chats`, "POST", { name: "deploys" })).status === 403, "a member can't create chats (403)");

    const view = await bff(ownerPage, `/bff/api/rooms/${roomId}`);
    const guestId = (view.body.members as { userId: string; username: string }[]).find((m) => m.username === guest)!.userId;
    await bff(ownerPage, `/bff/api/rooms/${roomId}/members/${guestId}`, "PATCH", { role: "admin" });
    check((await bff(guestPage, `/bff/api/rooms/${roomId}/chats`, "POST", { name: "deploys" })).status === 201, "after promotion the guest (admin) creates #deploys");
    check((await bff(guestPage, `/bff/api/rooms/${roomId}/members/${view.body.room.ownerId}`, "DELETE", {})).status === 403, "an admin can't remove the owner (403)");

    await bff(ownerPage, `/bff/api/rooms/${roomId}/invite`, "DELETE", {});
    const latePage = await person(browser);
    await signUp(latePage, late);
    check((await bff(latePage, `/bff/api/invites/${invite.body.code}/accept`, "POST", {})).status === 410, "a revoked invite link is refused (410)");

    check(!(await ownerPage.evaluate(() => document.cookie)).includes("cl_"), "page JavaScript can't read the session cookies");

    const roomUrl = `${WEB}/r/${roomId}`;
    await ownerPage.goto(roomUrl, { waitUntil: "networkidle0" });
    await ownerPage.evaluate(() => {
      (window as unknown as { __shifts: unknown[] }).__shifts = [];
      new PerformanceObserver((list) => (window as unknown as { __shifts: unknown[] }).__shifts.push(...list.getEntries()))
        .observe({ type: "layout-shift", buffered: false });
    });
    for (const i of [1, 0, 1]) {
      const links = await ownerPage.$$("nav[aria-label=Room] ul a");
      await links[i].click();
      await new Promise((r) => setTimeout(r, 700));
    }
    const shifts = await ownerPage.evaluate(() =>
      (window as unknown as { __shifts: { value: number; hadRecentInput: boolean }[] }).__shifts.map((e) => ({ value: e.value, hadRecentInput: e.hadRecentInput })));
    const cls = clsFrom(shifts);
    check(cls < 0.02, `switching chats doesn't shift the layout (CLS ${cls.toFixed(3)})`);

    const moving = await offsetFrames(ownerPage, roomUrl);
    check(moving >= 5, `switching chats slides the content in (${moving} frames in motion)`);
    await ownerPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const still = await offsetFrames(ownerPage, roomUrl);
    check(still === 0, `with reduced motion the content doesn't slide (${still} frames in motion)`);
    // Plain CSS transitions (button press, chevron turn) aren't Motion's, so they need their own reduced-motion rule.
    const longestCssMs = await ownerPage.evaluate(`Math.max(0, ...[...document.querySelectorAll("*")].flatMap((el) =>
      getComputedStyle(el).transitionDuration.split(",").map((d) => parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000))))`) as number;
    check(longestCssMs <= 1, `with reduced motion CSS transitions are instant (longest ${longestCssMs}ms)`);

    await ownerPage.goto(roomUrl, { waitUntil: "networkidle0" });
    await ownerPage.click('button[aria-label="Toggle room panel"]');
    await new Promise((r) => setTimeout(r, 600));
    const focusable = await ownerPage.evaluate(() => [...document.querySelectorAll('aside[aria-label="Room panel"] button')]
      .some((el) => { (el as HTMLElement).focus(); return document.activeElement === el; }));
    check(!focusable, "the closed room panel can't take keyboard focus");
    await ownerPage.click('button[aria-label="Toggle room panel"]');

    // The guest is removed behind the owner's back, so the owner's next action on them fails and must say so.
    await bff(ownerPage, `/bff/api/rooms/${roomId}/members/${guestId}`, "DELETE", {});
    await ownerPage.click(`button[aria-label="Actions for ${guest}"]`);
    await ownerPage.waitForSelector("[role=menuitem]");
    await ownerPage.evaluate(() => ([...document.querySelectorAll("[role=menuitem]")] as HTMLElement[]).find((b) => b.textContent === "Make member")?.click());
    const toasted = await toastSays(ownerPage, "Not a member of this room.");
    check(toasted, "a failed member action shows the server's reason instead of failing silently");

    // A token that looks fresh but the API rejects (as after a user pool reset) sends the user to sign in, then back here.
    const stalePage = await (await browser.createBrowserContext()).newPage();
    const fake = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    await stalePage.setCookie({ name: "cl_id", value: `${fake({ alg: "RS256" })}.${fake({ sub: "x", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`, url: WEB, httpOnly: true });
    await stalePage.goto(roomUrl, { waitUntil: "networkidle0" });
    check(stalePage.url().endsWith(`/login?next=${encodeURIComponent(`/r/${roomId}`)}`), `a rejected session goes to sign-in and remembers the page (${stalePage.url().replace(WEB, "")})`);

    await ownerPage.emulateMediaFeatures([]);
    await liveChecks(stamp, { page: ownerPage, name: owner }, { page: guestPage, name: guest }, { page: latePage, name: late });
    await threadChecks(stamp, { page: ownerPage, name: owner }, { page: guestPage, name: guest });
    await modelChecks(stamp, { page: ownerPage, name: owner }, { page: guestPage, name: guest });
    await fileChecks(stamp, { page: ownerPage, name: owner }, { page: guestPage, name: guest });
    await toolChecks(stamp, { page: ownerPage, name: owner }, { page: guestPage, name: guest });
    await mcpChecks(stamp, { page: ownerPage, name: owner }, { page: guestPage, name: guest });
    await emptyHomeCheck(browser, newcomer);
  } finally {
    await browser.close();
  }
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
