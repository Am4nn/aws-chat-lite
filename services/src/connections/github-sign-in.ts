import { createHash, randomBytes } from "node:crypto";
import { GitHubError, githubCall } from "../tools/github/app.js";
import type { ToolEnv } from "../tools/types.js";

type GitHubEnv = Pick<ToolEnv, "fetch" | "keys">;
export type Installation = { id: number; account: string; repos: string[] };
/** What the browser takes to GitHub's sign-in page. */
export type SignIn = { clientId: string; redirectUri: string; state: string; challenge: string };

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** PKCE (RFC 7636): a code taken from the browser is worthless without the verifier, which never leaves the server. */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** GitHub Apps take no scopes: a user token reaches only what both the App and the user can. */
export const githubSignInPage = ({ clientId, redirectUri, state, challenge }: SignIn) =>
  `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256",
  })}`;

async function userToken({ fetch, keys }: GitHubEnv, code: string, verifier: string, redirectUri: string): Promise<string> {
  const { githubClientId, githubClientSecret } = keys;
  if (!githubClientId || !githubClientSecret) throw new GitHubError("GitHub sign-in isn't set up here (no App client id).");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: githubClientId, client_secret: githubClientSecret, code, code_verifier: verifier, redirect_uri: redirectUri }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  // GitHub refuses a code with a 200 that carries an error field.
  if (!data.access_token) {
    console.error("GitHub refused the sign-in", res.status, data.error);
    throw new GitHubError("GitHub refused the sign-in.");
  }
  return data.access_token;
}

type Repo = { full_name: string; permissions?: { admin?: boolean; push?: boolean } };

/** GitHub sends at most 100 items a page; each reply's total_count says when the list is complete. */
async function allPages<T>(env: GitHubEnv, token: string, path: string, key: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const data = await githubCall(env, token, "GET", `${path}?per_page=100&page=${page}`);
    items.push(...data[key]);
    if (!data[key].length || items.length >= data.total_count) return items;
  }
}

/**
 * The App's installations the signed-in user can reach, each with only the repos that user can write to. GitHub
 * lists read-only repos too, but the agent writes with the App's own token, so a reader who connected one could have
 * the agent push there. The user token is used here and dropped.
 */
export async function userInstallations(env: GitHubEnv, code: string, verifier: string, redirectUri: string): Promise<Installation[]> {
  const token = await userToken(env, code, verifier, redirectUri);
  const installations = await allPages<{ id: number; account: { login: string } }>(env, token, "/user/installations", "installations");
  const reachable = await Promise.all(
    installations.map(async ({ id, account }) => {
      const repositories = await allPages<Repo>(env, token, `/user/installations/${id}/repositories`, "repositories");
      const writable = repositories.filter((r) => r.permissions?.push || r.permissions?.admin);
      return { id, account: account.login, repos: writable.map((r) => r.full_name) };
    }),
  );
  return reachable.filter((i) => i.repos.length);
}
