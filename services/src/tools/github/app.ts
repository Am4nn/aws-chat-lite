import { sign } from "node:crypto";
import type { ToolEnv } from "../types.js";

type GitHubEnv = Pick<ToolEnv, "fetch" | "keys">;
export type Permissions = Record<string, "read" | "write">;

const API = "https://api.github.com";
const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

/** A GitHub refusal, its message already written for the model. */
export class GitHubError extends Error {}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The App's own credential, good only for minting installation tokens. GitHub caps its life at ten minutes, and iat
 * sits a minute back to allow for clock drift between this host and GitHub.
 */
export function appJwt(appId: string, pem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), pem).toString("base64url")}`;
}

const CONNECT_TRIES = 3;
// Failures from before the connection opened: GitHub received nothing, so even a write is safe to send again.
const NEVER_CONNECTED = ["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"];

async function send(env: GitHubEnv, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await env.fetch(url, init);
    } catch (e) {
      const code = ((e as Error).cause as { code?: string } | undefined)?.code;
      if (attempt === CONNECT_TRIES || !NEVER_CONNECTED.includes(code ?? "")) throw e;
    }
  }
}

export async function githubCall(env: GitHubEnv, auth: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await send(env, `${API}${path}`, {
    method,
    headers: { ...HEADERS, Authorization: `Bearer ${auth}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new GitHubError(`GitHub sent a reply that isn't JSON (${res.status}).`);
  }
  if (!res.ok) throw new GitHubError(`GitHub said ${res.status}: ${failure(data, text).slice(0, 500)}`);
  return data;
}

type Failure = { message?: string; errors?: ({ message?: string; field?: string; code?: string } | string)[] };

/** A 422's message is only "Validation Failed"; the reason sits in its errors list. */
function failure(data: Failure | null, text: string): string {
  const reasons = (data?.errors ?? []).map((e) => (typeof e === "string" ? e : (e.message ?? [e.field, e.code].filter(Boolean).join(" "))));
  return `${data?.message ?? text}${reasons.length ? ` (${reasons.join("; ")})` : ""}`;
}

function jwtOf({ keys }: GitHubEnv): string {
  if (!keys.githubAppId || !keys.githubPrivateKey) throw new GitHubError("GitHub isn't set up here (no GitHub App key).");
  return appJwt(keys.githubAppId, keys.githubPrivateKey);
}

/**
 * A token for one repo with only the permissions one tool needs, minted per call: it lasts an hour at most, so a
 * leaked one is worth little, and a tool can never act beyond its own scope even if the App could.
 */
export async function installationToken(env: GitHubEnv, installationId: number, repo: string, permissions: Permissions): Promise<string> {
  const body = { repositories: [repo.split("/")[1]], permissions };
  try {
    return (await githubCall(env, jwtOf(env), "POST", `/app/installations/${installationId}/access_tokens`, body)).token;
  } catch (e) {
    if (e instanceof GitHubError && e.message.startsWith("GitHub said 422")) {
      const asked = Object.entries(permissions).map(([name, level]) => `${name}:${level}`);
      throw new GitHubError(`The GitHub App lacks ${asked.join(", ")} permission.`);
    }
    throw e;
  }
}
