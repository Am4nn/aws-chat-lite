/** What every smoke section shares: the result list, a person's isolated browser page, and in-page helpers. */
import type { Browser, Page } from "puppeteer-core";
import { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { readOutputs } from "./deploy-local.js";

export const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const PASSWORD = "password1";
export const results: [boolean, string][] = [];

/** The tab's socket, which the app exposes on `window` outside production so a test can drive and drop it. */
type DevLiveSocket = {
  status: string;
  ws: WebSocket;
  request(action: string, args: Record<string, unknown>): Promise<unknown>;
  on(type: string, fn: (e: { message: { roomId: string } }) => void): () => void;
};
declare global {
  interface Window { __live: DevLiveSocket; __seen: string[] }
}

export function check(ok: boolean, label: string) {
  results.push([ok, label]);
  console.log(`${ok ? "✅" : "❌"} ${label}`);
}

/**
 * Each person gets an isolated browser context, which also keeps Chrome's "save password" prompt from taking
 * keyboard and mouse focus away from the automated page.
 */
export async function person(browser: Browser): Promise<Page> {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${WEB}/login`, { waitUntil: "networkidle0" });
  return page;
}

/** Calls the BFF from inside the page, so the request carries that person's httpOnly cookies and Origin. */
export function bff(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(async (p, m, b) => {
    const res = await fetch(p, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, path, method, body);
}

export async function signUp(page: Page, username: string) {
  const r = await bff(page, "/bff/auth/signup", "POST", { username, password: PASSWORD });
  check(r.status === 200, `${username} signs up (and is signed in by an httpOnly cookie)`);
}

/** Adds the user to the creators group and signs in again, so the new ID token carries the group. */
export async function grantCreator(page: Page, username: string) {
  const { UserPoolId } = readOutputs("cl-local-core");
  await new CognitoIdentityProviderClient({}).send(new AdminAddUserToGroupCommand({ UserPoolId, Username: username, GroupName: "creators" }));
  await bff(page, "/bff/auth/signin", "POST", { username, password: PASSWORD });
}

/**
 * Waits for a condition inside the page and answers true or false, so a check can report it instead of throwing.
 * The page is brought to the front first: a background tab gets no animation frames, so Motion would stall there.
 */
export async function until<A>(page: Page, condition: (arg: A) => unknown, arg?: A, timeout = 8000): Promise<boolean> {
  await page.bringToFront();
  return page.waitForFunction(condition as (arg: unknown) => unknown, { timeout, polling: 100 }, arg).then(() => true, () => false);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const socketOpen = (page: Page) => until(page, () => window.__live?.status === "open", undefined, 12_000);
export const shows = (page: Page, text: string, timeout?: number) =>
  until(page, (t) => document.querySelector("main")?.innerText.includes(t), text, timeout);
export const toastSays = (page: Page, text: string) =>
  until(page, (t) => document.querySelector("[aria-live=polite]")?.textContent?.includes(t), text);

export async function send(page: Page, text: string) {
  await page.click("textarea#composer");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** A send straight over the socket, for messages whose composing isn't what the check is about. */
export const say = (page: Page, roomId: string, chatId: string, text: string) =>
  page.evaluate((r, c, t) => window.__live.request("send", { roomId: r, chatId: c, clientId: crypto.randomUUID(), text: t })
    .then(() => "ok", (e: Error) => e.message), roomId, chatId, text);
