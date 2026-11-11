import { afterEach, describe, expect, it, vi } from "vitest";
import { startMcpTestServer } from "../testing/server.js";
import { guardedFetch } from "./fetch.js";
import { beginAuthorization, completeAuthorization, revokeRemote, withFreshAuth } from "./oauth.js";
import { callRemoteTool, probe } from "./remote.js";
import { NeedsAuth, type StoredAuth, type TokenStore } from "./types.js";

const REDIRECT = "http://localhost:3000/bff/mcp/callback";
const HOSTS = ["127.0.0.1", "localhost"];
const f = guardedFetch({ localHosts: HOSTS });

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(o?: Parameters<typeof startMcpTestServer>[0]) {
  const server = await startMcpTestServer(o);
  servers.push(server);
  return server;
}

type TestServer = Awaited<ReturnType<typeof startMcpTestServer>>;

async function begin(server: TestServer, known?: { issuer: string; client: StoredAuth["client"] }) {
  const probed = await probe(server.url, f);
  if (probed.auth !== "oauth") throw new Error("The test server should want OAuth.");
  return beginAuthorization({ url: server.url, redirectUri: REDIRECT, probed, known }, f, HOSTS);
}

/** The admin's trip through the authorize page: the test server consents at once and redirects back with a code. */
async function signIn(server: TestServer) {
  const { authorizeUrl, pending } = await begin(server);
  const back = await f(authorizeUrl);
  const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
  return completeAuthorization(pending, code, f);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A versioned store like the table's; `saveMs` stands in for the write's round trip. */
function memoryStore(auth: StoredAuth | null, saveMs = 0) {
  let current = auth && { auth, version: 1 };
  const store = {
    load: vi.fn(async () => current),
    save: vi.fn(async (next: StoredAuth, version: number) => {
      await wait(saveMs);
      if (current?.version !== version) return false;
      current = { auth: next, version: version + 1 };
      return true;
    }),
    markNeedsAuth: vi.fn(async () => {}),
    get version() {
      return current?.version;
    },
  } satisfies TokenStore & { version: unknown };
  return store;
}

const echo = (server: TestServer, text: string) => (bearer?: string) => callRemoteTool(server.url, bearer, "echo", { text }, f);

describe("beginAuthorization", () => {
  it("registers chat-lite and builds a PKCE authorize URL for the server", async () => {
    const server = await start({ publicOrigin: "http://localhost:4710" });
    const { authorizeUrl, state, pending } = await begin(server);
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("http://localhost:4710/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(server.url);
    expect(url.searchParams.get("scope")).toBe("notes");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe(state);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending).toMatchObject({ issuer: server.origin, redirectUri: REDIRECT, resource: server.url });
    expect(pending.codeVerifier).toBeTruthy();
    expect(server.registrations).toBe(1);
  });

  it("reuses a known client of the same issuer", async () => {
    const server = await start();
    const { pending } = await begin(server);
    await begin(server, { issuer: pending.issuer, client: pending.client });
    expect(server.registrations).toBe(1);
    await begin(server, { issuer: "https://other.example", client: pending.client });
    expect(server.registrations).toBe(2);
  });

  it("registers again when the known client was registered for another return address", async () => {
    const server = await start();
    const { pending } = await begin(server);
    const elsewhere = { ...pending.client, redirect_uris: ["http://localhost:3100/bff/mcp/callback"] };
    const { pending: again } = await begin(server, { issuer: pending.issuer, client: elsewhere });
    expect(server.registrations).toBe(2);
    expect(again.client.client_id).not.toBe(pending.client.client_id);
  });

  it("explains a server that doesn't take new clients", async () => {
    const server = await start({ registration: false });
    await expect(begin(server)).rejects.toThrow("127.0.0.1 doesn't let new apps sign up, so chat-lite can't connect to it.");
  });

  it("refuses a script URL as the authorize page", async () => {
    const server = await start({ metadataOverrides: { authorization_endpoint: "javascript:alert(1)" } });
    await expect(begin(server)).rejects.toThrow();
  });

  it("refuses a plain-http authorize page", async () => {
    const server = await start({ metadataOverrides: { authorization_endpoint: "http://example.com/authorize" } });
    await expect(begin(server)).rejects.toThrow("Use an https URL.");
  });
});

describe("completeAuthorization", () => {
  it("swaps the code for tokens", async () => {
    const server = await start();
    const before = Date.now();
    const auth = await signIn(server);
    expect(auth.tokens.access_token).toMatch(/^at-/);
    expect(auth.tokens.refresh_token).toMatch(/^rt-/);
    expect(auth.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(auth).toMatchObject({ issuer: server.origin, resource: server.url });
    expect(await echo(server, "hi")(auth.tokens.access_token)).toEqual({ ok: true, output: "echo: hi" });
  });

  it("won't send the code to a metadata token endpoint on a private address", async () => {
    const server = await start({ metadataOverrides: { token_endpoint: "http://169.254.169.254/token" } });
    const { authorizeUrl, pending } = await begin(server);
    const code = new URL((await f(authorizeUrl)).headers.get("location")!).searchParams.get("code")!;
    await expect(completeAuthorization(pending, code, f)).rejects.toThrow("Use an https URL.");
  });
});

describe("withFreshAuth", () => {
  it("uses the stored access token while it is fresh", async () => {
    const server = await start();
    const store = memoryStore(await signIn(server));
    expect(await withFreshAuth(store, f, echo(server, "hi"))).toEqual({ ok: true, output: "echo: hi" });
    expect(server.refreshes).toBe(0);
    expect(store.version).toBe(1);
  });

  it("refreshes and retries once after a 401", async () => {
    const server = await start();
    const auth = await signIn(server);
    const store = memoryStore({ ...auth, tokens: { ...auth.tokens, access_token: "stale" } });
    expect(await withFreshAuth(store, f, echo(server, "hi"))).toEqual({ ok: true, output: "echo: hi" });
    expect(server.refreshes).toBe(1);
    expect(store.version).toBe(2);
  });

  it("survives two runs refreshing the same expired token at once", async () => {
    const server = await start({ accessTtlSec: 1 });
    const store = memoryStore(await signIn(server), 100);
    await wait(1_100);
    const results = await Promise.all([withFreshAuth(store, f, echo(server, "a")), withFreshAuth(store, f, echo(server, "b"))]);
    expect(results).toEqual([
      { ok: true, output: "echo: a" },
      { ok: true, output: "echo: b" },
    ]);
    expect(store.markNeedsAuth).not.toHaveBeenCalled();
    expect(store.version).toBe(2);
    expect(server.refreshes).toBe(1);
  });

  it("needs auth once the server revokes everything", async () => {
    const server = await start();
    const store = memoryStore(await signIn(server));
    server.revokeAll();
    await expect(withFreshAuth(store, f, echo(server, "hi"))).rejects.toBeInstanceOf(NeedsAuth);
    expect(store.markNeedsAuth).toHaveBeenCalledTimes(1);
  });

  it("needs auth when nothing is stored", async () => {
    const store = memoryStore(null);
    const use = vi.fn();
    await expect(withFreshAuth(store, f, use)).rejects.toBeInstanceOf(NeedsAuth);
    expect(store.markNeedsAuth).toHaveBeenCalledTimes(1);
    expect(use).not.toHaveBeenCalled();
  });
});

describe("revokeRemote", () => {
  it("revokes the refresh token", async () => {
    const server = await start();
    const auth = await signIn(server);
    await revokeRemote(auth, f);
    const store = memoryStore({ ...auth, expiresAt: 0 });
    await expect(withFreshAuth(store, f, echo(server, "hi"))).rejects.toBeInstanceOf(NeedsAuth);
  });

  it("never throws", async () => {
    const server = await start();
    const auth = await signIn(server);
    await server.close();
    await expect(revokeRemote(auth, f)).resolves.toBeUndefined();
    await expect(revokeRemote({ ...auth, metadata: { ...auth.metadata, revocation_endpoint: "javascript:x" } }, f)).resolves.toBeUndefined();
  });
});
