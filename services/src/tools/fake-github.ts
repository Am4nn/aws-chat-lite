import { createHash, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import type { SignIn } from "../connections/github-sign-in.js";
import type { ToolKeys } from "./types.js";

const REPO = "fake-org/playground";
const BRANCHES: Record<string, string> = { main: "sha-main", feature: "sha-feature" };
const README = "# Playground\n\nA fake repo for tests.\n";

let pair: { privatePem: string; publicKey: KeyObject } | undefined;

function keyPair() {
  if (!pair) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    pair = { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey };
  }
  return pair;
}

/**
 * Fake mode's keys: an RSA key made once per container, so the real JWT signing runs, and stand-in client and Tavily
 * keys, so the real sign-in and search requests are built. Nothing real is ever needed.
 */
export const fakeKeys = (): ToolKeys => ({
  githubAppId: "1", githubAppSlug: "fake-app", githubPrivateKey: keyPair().privatePem, tavilyKey: "fake-tavily-key",
  githubClientId: "fake-client-id", githubClientSecret: "fake-client-secret",
});

/**
 * Fake mode's GitHub sign-in page: the browser goes straight back to the return address, as GitHub does for a user
 * who already authorized the App. The code carries the PKCE challenge, so the fake token exchange can check the verifier.
 */
export const fakeSignInPage = ({ redirectUri, state, challenge }: SignIn) =>
  `${redirectUri}?${new URLSearchParams({ code: `fake-code.${challenge}`, state })}`;

function userToken(body: { client_id?: string; client_secret?: string; code?: string; code_verifier?: string }): Response {
  const [prefix, challenge] = (body.code ?? "").split(".");
  const verified = !!body.code_verifier && createHash("sha256").update(body.code_verifier).digest("base64url") === challenge;
  if (body.client_id !== "fake-client-id" || body.client_secret !== "fake-client-secret") return json(200, { error: "incorrect_client_credentials" });
  if (prefix !== "fake-code" || !verified) return json(200, { error: "bad_verification_code" });
  return json(200, { access_token: "ghu_fake", token_type: "bearer" });
}

function validJwt(jwt: string): boolean {
  const [header, payload, signature] = jwt.split(".");
  if (!signature) return false;
  const signed = verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keyPair().publicKey, Buffer.from(signature, "base64url"));
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  return signed && claims.iss === "1" && claims.exp > Date.now() / 1000;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const notFound = () => json(404, { message: "Not Found" });

const user = { login: "octocat" };
const issue = (number: number) => ({
  number,
  title: number === 2 ? "Add a greeting" : "The README is short",
  state: "open",
  user,
  labels: [{ name: "docs" }],
  body: "Please look.",
  html_url: `https://github.com/${REPO}/issues/${number}`,
  ...(number === 2 && { pull_request: { url: "" } }),
});
const pull = (number: number) => ({
  ...issue(number),
  head: { ref: "feature" },
  base: { ref: "main" },
  merged: false,
  mergeable: true,
  html_url: `https://github.com/${REPO}/pull/${number}`,
});

type Route = [method: string, path: RegExp, answer: (match: RegExpMatchArray, body: any) => Response];

const REPO_ROUTES: Route[] = [
  ["GET", /^$/, () => json(200, { full_name: REPO, default_branch: "main" })],
  ["GET", /^\/issues$/, () => json(200, [issue(1), issue(2)])],
  ["GET", /^\/pulls$/, () => json(200, [pull(2)])],
  ["GET", /^\/issues\/([12])$/, (m) => json(200, issue(Number(m[1])))],
  ["GET", /^\/issues\/\d+\/comments$/, () => json(200, [{ user, created_at: "2026-11-01T10:00:00Z", body: "Looks good." }])],
  ["GET", /^\/pulls\/2$/, () => json(200, pull(2))],
  [
    "GET",
    /^\/pulls\/2\/files$/,
    () => json(200, [{ filename: "README.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-old\n+new" }]),
  ],
  [
    "GET",
    /^\/contents\/README\.md$/,
    () => json(200, { type: "file", path: "README.md", size: README.length, encoding: "base64", content: Buffer.from(README).toString("base64") }),
  ],
  [
    "GET",
    /^\/contents\/?$/,
    () => json(200, [{ type: "file", path: "README.md", size: README.length }, { type: "dir", path: "src", size: 0 }]),
  ],
  ["POST", /^\/issues\/(\d+)\/comments$/, (m) => json(201, { html_url: `https://github.com/${REPO}/issues/${m[1]}#issuecomment-1` })],
  ["POST", /^\/issues$/, () => json(201, { number: 3, html_url: `https://github.com/${REPO}/issues/3` })],
  ["POST", /^\/issues\/\d+\/labels$/, (_, body) => json(200, body.labels.map((name: string) => ({ name })))],
  ["GET", /^\/git\/ref\/heads\/(.+)$/, (m) => (BRANCHES[m[1]] ? json(200, { object: { sha: BRANCHES[m[1]] } }) : notFound())],
  ["POST", /^\/git\/trees$/, () => json(201, { sha: "sha-tree" })],
  ["POST", /^\/git\/commits$/, () => json(201, { sha: "sha-commit-0001", html_url: `https://github.com/${REPO}/commit/sha-commit-0001` })],
  ["POST", /^\/git\/refs$/, (_, body) => json(201, { ref: body.ref })],
  ["PATCH", /^\/git\/refs\/heads\/(.+)$/, (m) => (BRANCHES[m[1]] ? json(200, { ref: `refs/heads/${m[1]}` }) : notFound())],
  ["POST", /^\/pulls$/, () => json(201, { number: 5, html_url: `https://github.com/${REPO}/pull/5` })],
  ["PUT", /^\/pulls\/\d+\/merge$/, () => json(200, { merged: true, sha: "sha-merge-0001" })],
];

function serve(routes: Route[], method: string, path: string, body: unknown): Response {
  for (const [m, pattern, answer] of routes) {
    const match = m === method ? path.match(pattern) : null;
    if (match) return answer(match, body);
  }
  return notFound();
}

/**
 * A stand-in for api.github.com and GitHub's token exchange: one installation (1, fake-org) with one repo whose default
 * branch is main. App routes check the JWT against the fake key, installation routes want the installation token this
 * fake mints, and user routes the user token it hands out for its own sign-in codes.
 */
export const fakeGitHubFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? "GET";
  const auth = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const path = url.pathname;

  if (url.hostname === "github.com") return method === "POST" && path === "/login/oauth/access_token" ? userToken(body ?? {}) : notFound();
  if (path.startsWith("/user/")) {
    if (auth !== "ghu_fake") return json(401, { message: "Bad credentials" });
    if (path === "/user/installations") return json(200, { total_count: 1, installations: [{ id: 1, account: { login: "fake-org" } }] });
    if (path === "/user/installations/1/repositories") {
      return json(200, { total_count: 1, repositories: [{ full_name: REPO, permissions: { admin: true, push: true, pull: true } }] });
    }
    return notFound();
  }

  if (path.startsWith("/app/")) {
    if (!validJwt(auth)) return json(401, { message: "A JSON web token could not be decoded" });
    if (method === "POST" && path === "/app/installations/1/access_tokens") {
      const repos: string[] = body?.repositories ?? [];
      if (repos.some((r) => r !== "playground")) return json(422, { message: "There is at least one repository that does not exist" });
      return json(201, { token: "ghs_fake", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return notFound();
  }
  if (auth !== "ghs_fake") return json(401, { message: "Bad credentials" });
  if (path === `/repos/${REPO}` || path.startsWith(`/repos/${REPO}/`)) {
    return serve(REPO_ROUTES, method, path.slice(`/repos/${REPO}`.length), body);
  }
  return notFound();
};

export type GitHubCall = { method: string; path: string; body?: any };

/** The fake, recording each call; `answer` can stand in for it on chosen calls. */
export function recordGitHub(answer?: (call: GitHubCall) => Response | undefined) {
  const calls: GitHubCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call = { method: init?.method ?? "GET", path: url.pathname + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return answer?.(call) ?? fakeGitHubFetch(input, init);
  };
  return { calls, fetch };
}
