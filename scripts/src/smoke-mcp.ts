/**
 * MCP both ways, between real browsers on the fake model. As a client: an admin connects the local OAuth MCP test
 * server (`npm run dev` runs it on 4710) from the room panel while a member only sees it, an agent calls its read-only
 * tool freely and its write after a member's Approve, a lost sign-in reads as needing a reconnect until Reconnect, and
 * Remove takes it away. As a server: the MCP SDK's own client signs in through discovery, registration and the consent
 * page, lists and posts as the user, and is shut out once the app is removed in Connected apps. Plus the endpoint's
 * refusals and rate limit, the frame headers, phone width and reduced motion.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "puppeteer-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { readOutputs } from "./deploy-local.js";
import { PANEL, PASSWORD, WEB, bff, check, clickButton, eventually, openTab, panelShows, socketOpen, toastSays, until } from "./smoke-page.js";

type Person = { page: Page; name: string };
type Thread = { threadId: string; number: number; status: string; steps: number; taint: string[] };

const SERVER_URL = "http://host.docker.internal:4710/mcp";
const RUN_MS = 60_000;
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true };

/**
 * Counts the frames in which the element matching `selector` is part-way through a fade (neither hidden nor fully
 * shown), from the moment `action` runs until 800 ms later. Sent as text because the TypeScript runner wraps named
 * functions in a helper that doesn't exist inside the browser.
 */
const fadeFrames = (selector: string, action: string) => `new Promise((resolve) => {
  let moving = 0;
  const start = performance.now();
  const sample = (now) => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const opacity = el ? Number(getComputedStyle(el).opacity) : 1;
    if (opacity > 0 && opacity < 1) moving++;
    if (now - start < 800) requestAnimationFrame(sample); else resolve(moving);
  };
  requestAnimationFrame(sample);
  ${action}
})`;
const clickText = (text: string) =>
  `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click();`;

/** The MCP client's loopback redirect (RFC 8252): it answers the browser and hands the query to whoever is waiting. */
async function loopback() {
  const waiting: ((q: URLSearchParams) => void)[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.writeHead(url.pathname === "/callback" ? 200 : 404, { "content-type": "text/plain" }).end("Done. You can close this tab.");
    if (url.pathname === "/callback") waiting.shift()?.(url.searchParams);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
    next: () => new Promise<URLSearchParams>((resolve) => waiting.push(resolve)),
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** An in-memory public OAuth client, as Claude Code keeps one: it registers itself and records where to send the browser. */
function smokeClient(redirectUrl: string) {
  let info: OAuthClientInformationMixed | undefined;
  let saved: OAuthTokens | undefined;
  let verifier = "";
  const provider: OAuthClientProvider & { authorizeUrl?: URL } = {
    redirectUrl,
    clientMetadata: { client_name: "smoke-client", redirect_uris: [redirectUrl], token_endpoint_auth_method: "none" },
    state: () => randomBytes(16).toString("base64url"),
    clientInformation: () => info,
    saveClientInformation: (i) => { info = i; },
    tokens: () => saved,
    saveTokens: (t) => { saved = t; },
    redirectToAuthorization: (url) => { provider.authorizeUrl = url; },
    saveCodeVerifier: (v) => { verifier = v; },
    codeVerifier: () => verifier,
  };
  return provider;
}

/** Connects the SDK client; with no tokens yet it is refused, and the provider holds the authorize URL. */
async function connectClient(mcpUrl: URL, provider: OAuthClientProvider) {
  const client = new Client({ name: "smoke-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  const error = await client.connect(transport).then(() => null, (e: Error) => e);
  return { client, transport, error };
}

const textOf = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const db = () => DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** Starts each hour's registration and authorize allowance afresh, so the smoke can count to the limit on any run. */
async function resetOAuthRates() {
  const TableName = readOutputs("cl-local-core").TableName;
  const { Items = [] } = await db().send(new ScanCommand({
    TableName, FilterExpression: "begins_with(pk, :p)", ExpressionAttributeValues: { ":p": "RATE#oauth#" }, ProjectionExpression: "pk, sk",
  }));
  for (let i = 0; i < Items.length; i += 25) {
    await db().send(new BatchWriteCommand({ RequestItems: { [TableName]: Items.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) } }));
  }
}

/** The text of the panel's "MCP servers" section. */
const mcpSection = (page: Page) => page.evaluate((panel) => [...document.querySelectorAll(`${panel} section`)]
  .find((s) => s.querySelector("h2")?.textContent === "MCP servers")?.textContent ?? "", PANEL);

const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth);

export async function mcpChecks(stamp: number, owner: Person, guest: Person) {
  const A = owner.page;
  const B = guest.page;
  const BASE = String(readOutputs("cl-local-core").McpBaseUrl);
  const mcpUrl = new URL(`${BASE}/mcp`);
  const roomName = `mcp ${stamp}`;
  const { roomId, generalChatId: general } = (await bff(A, "/bff/api/rooms", "POST", { name: roomName })).body as { roomId: string; generalChatId: string };
  const { code } = (await bff(A, `/bff/api/rooms/${roomId}/invite`, "POST", {})).body;
  await bff(B, `/bff/api/invites/${code}/accept`, "POST", {});
  await resetOAuthRates();

  const generalUrl = `${WEB}/r/${roomId}/c/${general}`;
  const threadUrl = (n: number) => `${WEB}/r/${roomId}/t/${n}`;
  const thread = async (n: number) => ((await bff(A, `/bff/api/rooms/${roomId}`)).body.threads as Thread[]).find((t) => t.number === n)!;
  const ended = (n: number) => eventually(() => thread(n), (t) => t.status !== "running" && t.status !== "waiting");
  const ask = async (text: string) =>
    (await bff(A, `/bff/api/rooms/${roomId}/threads`, "POST", { text, clientId: crypto.randomUUID() })).body.thread as Thread;
  const open = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea#composer");
    await socketOpen(page);
  };
  for (const page of [A, B]) {
    await open(page, generalUrl);
    await openTab(page, "Connections");
  }
  const toolLabels = async (page: Page) => {
    await page.bringToFront();
    if (!(await page.$("#mcp-tools-test"))) await page.evaluate(clickText("Show tools"));
    return until(page, () => ["echo:read-only", "add_note:asks first", "whoami:read-only", "fail:read-only"].every((pair) => {
      const [tool, label] = pair.split(":");
      return document.querySelector(`#mcp-tools-test li[aria-label="${tool}"]`)?.textContent?.endsWith(label!);
    }));
  };

  // Connect: B, a member, sees none yet and nothing to add one with; A adds the test server and its sign-in round trip
  // lands back on the room with a toast.
  const empty = await until(B, (panel) => [...document.querySelectorAll(`${panel} section`)]
    .some((s) => s.querySelector("h2")?.textContent === "MCP servers" && s.textContent?.includes("None yet.")), PANEL);
  const noAdd = await B.evaluate(() => ![...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Add MCP server"));
  await A.bringToFront();
  await clickButton(A, "Add MCP server");
  await A.type("#mcp-name", "test");
  await A.type("#mcp-url", SERVER_URL);
  const landed = A.waitForNavigation({ waitUntil: "domcontentloaded", timeout: RUN_MS });
  await clickButton(A, "Connect");
  await landed;
  const toasted = await toastSays(A, "Connected test");
  const back = await until(A, (path) => location.pathname === path && location.search === "", `/r/${roomId}/c/${general}`);
  check(empty && noAdd && toasted && back,
    `B sees "None yet." and no Add MCP server; A adds test = ${SERVER_URL}, passes the server's sign-in and lands back on #general with "Connected test"`);
  await socketOpen(A);
  const labelled = await toolLabels(A);
  const seen = await panelShows(B, ["test", "host.docker.internal:4710", "connected"], 15_000) && await toolLabels(B);
  const stillNoAdd = await B.evaluate(() => ![...document.querySelectorAll("button")].some((b) => ["Add MCP server", "Reconnect", "Refresh tools", "Remove"].includes(b.textContent?.trim() ?? "")));
  check(labelled && seen && stillNoAdd, "both see test connected with echo, whoami and fail read-only and add_note asks first; B has no Add, Reconnect, Refresh or Remove");

  // A read-only tool runs without asking, and its output makes the thread private.
  const read = await ask("@agent go call:mcp__test__echo");
  const readDone = await ended(read.number);
  check(readDone.status === "done" && readDone.steps === 1 && readDone.taint.includes("mcp"),
    `call:mcp__test__echo runs without an approval (${readDone.status}, ${readDone.steps} step) and taints #${read.number} with mcp (${readDone.taint.join(", ")})`);

  // A write waits for a member: B gets "needs you", opens the card and approves.
  const write = await ask("@agent go call:mcp__test__add_note");
  const rowOf = `nav[aria-label="Room"] a[href="/r/${roomId}/t/${write.number}"]`;
  const needsYou = await until(B, (row) => document.querySelector(row)?.textContent?.includes("needs you"), rowOf, RUN_MS);
  await open(B, threadUrl(write.number));
  const carded = await until(B, () => [...document.querySelectorAll("main p")].some((p) => p.textContent === "Run add_note on test?"), undefined, 15_000);
  await clickButton(B, "Approve");
  const writeDone = await ended(write.number);
  check(needsYou && carded && writeDone.status === "done" && writeDone.steps === 1,
    `call:mcp__test__add_note waits: B's row says "needs you", the card reads "Run add_note on test?", and after Approve the run ends ${writeDone.status} after ${writeDone.steps} step`);
  await open(B, generalUrl);
  await openTab(B, "Connections");
  const logged = await panelShows(B, [
    `${owner.name} connected MCP test (host.docker.internal)`, `@agent ran mcp__test__echo in #${read.number}`,
    `${guest.name} approved "Run add_note on test?" in #${write.number}`, `@agent ran mcp__test__add_note in #${write.number}`,
  ], 15_000);
  check(logged, "B's Activity lists the connection, both tool runs and the approval");

  // A sign-in that won't open (as after the token key changes) reads as needing a reconnect, and Reconnect mends it.
  await db().send(new UpdateCommand({
    TableName: readOutputs("cl-local-core").TableName, Key: { pk: `ROOM#${roomId}`, sk: "MCPAUTH#test" },
    UpdateExpression: "SET sealed = :x", ExpressionAttributeValues: { ":x": "not a sealed blob" },
  }));
  const lost = await ask("@agent go call:mcp__test__whoami");
  const lostDone = await ended(lost.number);
  const amber = await until(B, () => document.querySelector('li[aria-label="test"]')?.textContent?.includes("needs reconnecting"), undefined, 15_000);
  await A.bringToFront();
  const relanded = A.waitForNavigation({ waitUntil: "domcontentloaded", timeout: RUN_MS });
  await clickButton(A, "Reconnect");
  await relanded;
  const reconnected = (await toastSays(A, "Connected test"))
    && await until(B, () => document.querySelector('li[aria-label="test"]')?.textContent?.includes("connected")
      && !document.querySelector('li[aria-label="test"]')?.textContent?.includes("needs reconnecting"), undefined, 15_000);
  check(lostDone.status === "done" && amber && reconnected,
    `with the stored sign-in unreadable, #${lost.number}'s call marks test "needs reconnecting" for B; A's Reconnect signs in again and both see it connected`);

  // Reduced motion on the panel: the tool list opens with a fade normally and at once under reduced motion.
  await socketOpen(A);
  await openTab(A, "Connections");
  await A.waitForSelector('li[aria-label="test"]');
  if (await A.$("#mcp-tools-test")) {
    await A.evaluate(clickText("Hide tools"));
    await A.waitForFunction(() => !document.querySelector("#mcp-tools-test"));
  }
  const fading = await A.evaluate(fadeFrames("#mcp-tools-test", clickText("Show tools"))) as number;
  await A.evaluate(clickText("Hide tools"));
  await A.waitForFunction(() => !document.querySelector("#mcp-tools-test"));
  // Motion reads the preference when a component mounts, so the page loads again under it.
  await A.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await open(A, generalUrl);
  await openTab(A, "Connections");
  await A.waitForSelector('li[aria-label="test"]');
  const instantly = await A.evaluate(fadeFrames("#mcp-tools-test", clickText("Show tools"))) as number;
  await A.emulateMediaFeatures([]);
  check(fading >= 3 && instantly === 0, `the tool list fades open (${fading} frames), and under reduced motion opens at once (${instantly})`);

  // Phone: the room panel's MCP section fits 390 px.
  const phone = await A.browserContext().newPage();
  await phone.setViewport(PHONE);
  await phone.goto(generalUrl, { waitUntil: "domcontentloaded" });
  await phone.waitForSelector('button[aria-label="Toggle room panel"]');
  await phone.click('button[aria-label="Toggle room panel"]');
  await openTab(phone, "Connections");
  const panelFits = await until(phone, () => {
    const row = document.querySelector('li[aria-label="test"]')?.getBoundingClientRect();
    return !!row && row.left >= 0 && row.right <= innerWidth && document.scrollingElement!.scrollWidth <= innerWidth;
  }, undefined, 15_000);
  await phone.close();
  check(panelFits, "at 390×844 the room panel's MCP server row fits with no horizontal scroll");

  // chat-lite as a server: the SDK's client finds the sign-in from the 401, registers and sends A's browser to consent.
  const redirect = await loopback();
  try {
    const provider = smokeClient(redirect.url);
    const first = await connectClient(mcpUrl, provider);
    const refused = first.error instanceof UnauthorizedError && !!provider.authorizeUrl;
    const authorizeUrl = provider.authorizeUrl!.href;
    await A.goto(authorizeUrl, { waitUntil: "networkidle0" });
    const requestId = new URL(A.url()).searchParams.get("request") ?? "";
    const consentUrl = `${WEB}/consent?request=${requestId}`;
    const lines = await A.evaluate(() => document.querySelector("main")!.innerText.split("\n").map((l) => l.trim()).filter(Boolean));
    const want = [
      "Allow smoke-client to use chat-lite?", `Signed in as ${owner.name}.`,
      "Read your rooms, chats and threads", "Post messages and start agent threads as you",
      "It reaches only rooms you're in. You can remove it any time in Connected apps.",
      `After you choose, you go back to ${new URL(redirect.url).host}.`,
      "chat-lite hasn't checked who made this app. Allow it only if you started this from an app you trust.",
      "Cancel", "Allow",
    ];
    check(refused && A.url() === consentUrl && JSON.stringify(lines) === JSON.stringify(want),
      `the SDK client is refused, registers and sends the browser via authorize to ${consentUrl.replace(WEB, "")}, which reads exactly as specified${JSON.stringify(lines) === JSON.stringify(want) ? "" : ` (got ${JSON.stringify(lines)})`}`);

    // The same request open on a phone fits; Allow there after Allow here finds it used, and the page says so.
    const stale = await A.browserContext().newPage();
    await stale.setViewport(PHONE);
    await stale.goto(consentUrl, { waitUntil: "networkidle0" });
    const consentFits = await noSideScroll(stale);
    const answered = redirect.next();
    // Answered from a DOM observer rather than a frame, because the page leaves as soon as the decision is stored.
    await A.bringToFront();
    const disabledAfterClick = await A.evaluate(() => new Promise<boolean>((resolve) => {
      const buttons = [...document.querySelectorAll("main button")] as HTMLButtonElement[];
      const observer = new MutationObserver(() => {
        if (buttons.every((b) => b.disabled)) resolve(true);
      });
      observer.observe(document.querySelector("main")!, { attributes: true, subtree: true, attributeFilter: ["disabled"] });
      setTimeout(() => resolve(false), 2000);
      buttons.find((b) => b.textContent?.trim() === "Allow")!.click();
    }));
    const allowed = await answered;
    const gotCode = !!allowed.get("code") && !allowed.get("error");
    await clickButton(stale, "Allow");
    const expiredCopy = await until(stale, () => document.querySelector("main")?.innerText.includes("This sign-in request expired. Start again from your app."), undefined, 15_000);
    await stale.close();
    await open(A, generalUrl);
    check(gotCode && disabledAfterClick && consentFits && expiredCopy,
      "Allow disables both buttons and returns a code to the client's loopback; the consent page fits 390×844, and Allow on a stale copy shows the expired copy");

    await first.transport.finishAuth(allowed.get("code")!);
    const { client, error } = await connectClient(mcpUrl, provider);
    const tools = error ? [] : (await client.listTools()).tools.map((t) => t.name);
    const rooms = error ? "" : textOf(await client.callTool({ name: "list_rooms", arguments: {} }));
    check(tools.join() === "list_rooms,list_room,read_messages,post_message,start_thread" && rooms.includes(`${roomName} · owner · id ${roomId}`),
      `with the code swapped for tokens, the client lists ${tools.length} tools and list_rooms includes "${roomName}"`);

    // A post made over MCP shows live, as A, on B's page.
    await open(B, generalUrl);
    const posted = textOf(await client.callTool({ name: "post_message", arguments: { room: roomId, chat: "general", text: `deploy done ${stamp}` } }));
    const live = await until(B, (t) => document.querySelector("main")?.innerText.includes(t), `deploy done ${stamp}`, 15_000);
    const last = (await bff(A, `/bff/api/rooms/${roomId}/chats/${general}/messages`)).body.messages.at(-1) as { text: string; authorName?: string; authorId: string };
    const me = (await bff(A, "/bff/api/me")).body as { userId: string };
    check(posted.startsWith("Posted to #general") && live && last.authorId === me.userId,
      `post_message to #general shows "deploy done ${stamp}" on B's page at once, from A`);

    // Cancel, from a browser that isn't signed in: sign-in first, back to the same request, then the client hears no.
    const cancelProvider = smokeClient(redirect.url);
    await connectClient(mcpUrl, cancelProvider);
    const fresh = await (await A.browser().createBrowserContext()).newPage();
    await fresh.goto(cancelProvider.authorizeUrl!.href, { waitUntil: "networkidle0" });
    const toLogin = new URL(fresh.url());
    const nextPath = toLogin.searchParams.get("next") ?? "";
    await fresh.type("#username", owner.name);
    await fresh.type("#password", PASSWORD);
    const signedIn = fresh.waitForNavigation({ waitUntil: "networkidle0" });
    await fresh.keyboard.press("Enter");
    await signedIn;
    const backAtConsent = fresh.url() === `${WEB}${nextPath}` && nextPath.startsWith("/consent?request=");
    const denied = redirect.next();
    await clickButton(fresh, "Cancel");
    const deniedQuery = await denied;
    await fresh.browserContext().close();
    check(toLogin.pathname === "/login" && backAtConsent && deniedQuery.get("error") === "access_denied" && !deniedQuery.get("code"),
      `signed out, authorize goes to /login?next=${nextPath} and back to it after sign-in; Cancel returns error=access_denied to the client`);

    // The frame headers, on /login too (a framed /consent sends a signed-out visitor there), and a real iframe refused.
    const headers = await A.evaluate(async () => Promise.all(["/consent", "/apps", "/login"].map(async (path) => {
      const res = await fetch(path, { redirect: "manual" });
      return `${res.headers.get("content-security-policy")} | ${res.headers.get("x-frame-options")}`;
    })));
    const framer = await A.browserContext().newPage();
    const refusals: string[] = [];
    framer.on("console", (m) => { if (/frame-ancestors/.test(m.text())) refusals.push(m.text()); });
    await framer.setContent(`<iframe src="${WEB}/apps"></iframe>`, { waitUntil: "load" });
    await framer.close();
    check(headers.every((h) => h === "frame-ancestors 'none' | DENY") && refusals.length > 0,
      `/consent, /apps and /login send frame-ancestors 'none' and X-Frame-Options DENY, and Chrome refuses to frame /apps (${refusals.length} refusal)`);

    // Connected apps: listed, fits a phone, and Remove (row gone at once under reduced motion) shuts the client out.
    await A.goto(`${WEB}/r/${roomId}`, { waitUntil: "domcontentloaded" });
    const linked = !!(await A.waitForSelector('a[aria-label="Connected apps"]', { timeout: 15_000 }).catch(() => null));
    await A.goto(`${WEB}/apps`, { waitUntil: "networkidle0" });
    const listed = await A.evaluate(() => document.querySelector("main")!.innerText.includes("smoke-client"));
    const appsPhone = await A.browserContext().newPage();
    await appsPhone.setViewport(PHONE);
    await appsPhone.goto(`${WEB}/apps`, { waitUntil: "networkidle0" });
    const appsFit = await noSideScroll(appsPhone);
    await appsPhone.close();
    await A.click('button[aria-label="Remove smoke-client"]');
    await A.waitForSelector("[role=dialog]");
    const asked = await A.evaluate(() => document.querySelector("[role=dialog]")!.textContent!.includes("Remove smoke-client?It loses access at once."));
    await A.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const rowFade = await A.evaluate(fadeFrames("main ul li",
      `[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Remove").click();`)) as number;
    await A.emulateMediaFeatures([]);
    const gone = await until(A, () => document.querySelector("main")?.innerText.includes("No apps have access."), undefined, 15_000);
    const after = await client.callTool({ name: "list_rooms", arguments: {} }).then(() => "answered", (e: Error) => e.name);
    const raw = await fetch(mcpUrl, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${(await provider.tokens())!.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await client.close();
    check(linked && listed && appsFit && asked && rowFade === 0 && gone && raw.status === 401 && after !== "answered",
      `the sidebar links Connected apps, which lists smoke-client and fits 390×844; Remove asks, the row goes at once under reduced motion, "No apps have access." shows, and the app's token now gets ${raw.status} (SDK: ${after})`);
  } finally {
    redirect.close();
  }

  // The endpoint's refusals, as curl would see them.
  const post = (headers: Record<string, string>) => fetch(mcpUrl, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const foreign = await post({ origin: "https://evil.example", authorization: "Bearer cl_at_x_y" });
  const getMcp = await fetch(mcpUrl);
  const anonymous = await post({});
  const challenge = anonymous.headers.get("www-authenticate") ?? "";
  check(foreign.status === 403 && getMcp.status === 405 && getMcp.headers.get("allow") === "POST"
    && anonymous.status === 401 && challenge.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`),
    `/mcp: a foreign Origin gets ${foreign.status}, GET gets ${getMcp.status} (Allow: ${getMcp.headers.get("allow")}), no token gets ${anonymous.status} pointing at the resource metadata`);

  await resetOAuthRates();
  const register = () => fetch(`${BASE}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "smoke-rate", redirect_uris: ["http://127.0.0.1:1/callback"] }),
  });
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++) statuses.push((await register()).status);
  const over = await register();
  const overBody = await over.json().catch(() => ({})) as { error?: string };
  await resetOAuthRates();
  check(statuses.every((s) => s === 201) && over.status === 429 && overBody.error === "slow_down",
    `20 registrations from one address get 201; the 21st gets ${over.status} ${overBody.error}`);

  // Remove: B sees it go, and the log says who.
  await open(A, generalUrl);
  await openTab(A, "Connections");
  await open(B, generalUrl);
  await openTab(B, "Connections");
  await B.waitForSelector('li[aria-label="test"]');

  // A server that doesn't answer: the admin reads why in a toast, and nothing is added. Inside the Lambda, localhost
  // is the Lambda's own container, where nothing listens.
  await A.bringToFront();
  await clickButton(A, "Add MCP server");
  await A.type("#mcp-name", "down");
  await A.type("#mcp-url", "http://localhost:4799/mcp");
  await clickButton(A, "Connect");
  const refusal = await A.waitForFunction(() => [...document.querySelectorAll("[aria-live=polite]")]
    .map((r) => r.textContent ?? "").find((t) => t.includes("localhost")), { timeout: 30_000 }).then((h) => h.jsonValue(), () => "");
  const notAdded = !(await A.$('li[aria-label="down"]'));
  check(!!refusal && notAdded, `a server that doesn't answer isn't added, and the toast says why ("${refusal}")`);
  await clickButton(A, "Cancel");

  await clickButton(A, "Remove");
  const confirmCopy = await until(A, () => document.querySelector('li[aria-label="test"]')?.textContent?.includes("Remove test? Agents lose its tools at once."));
  await A.evaluate(() => ([...document.querySelectorAll('li[aria-label="test"] button')] as HTMLElement[]).find((b) => b.textContent?.trim() === "Remove")!.click());
  const rowGone = await until(B, () => !document.querySelector('li[aria-label="test"]'), undefined, 15_000);
  const removed = rowGone && (await mcpSection(B)).includes("None yet.")
    && await panelShows(B, [`${owner.name} disconnected MCP test`], 15_000);
  check(confirmCopy && removed, `A's Remove asks "Remove test? Agents lose its tools at once."; B sees the row go, "None yet." and "${owner.name} disconnected MCP test"`);
}
