import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appJwt, githubCall, installationToken } from "./github/app.js";
import { findTool } from "./index.js";
import type { ToolEnv, ToolResult } from "./types.js";
import { fetchPage } from "./web/fetch.js";

// Real calls, opt-in: REAL_TOOLS=1 npm -w services run test:live -- tools. One Tavily search from the free quota.
// GitHub writes only ever touch the playground repo, and never its default branch: the PR merges into a throwaway
// base branch, and the suite deletes both branches and the label it made.
const REPO = "Am4nn/chat-lite-playground";
const LABEL = "live-test";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const STAMP = Date.now();
const BASE = `live/${STAMP}-base`;
const HEAD = `live/${STAMP}`;

let env: ToolEnv;
let labelExisted = true;
/** The PR while it is open, so a run that fails before the merge still closes it. */
let openPr: number | undefined;

const run = (name: string, input: Record<string, unknown>): Promise<ToolResult> => findTool(name, { roomId: "live", mcp: [] })!.run(input, env);

/** Every write names the playground, and the connection holds nothing else, so no call can land anywhere else. */
async function write(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  expect(input.repo).toBe(REPO);
  expect(env.github!.repos).toEqual([REPO]);
  const result = await run(name, input);
  console.log(`${name}: ${result.output}`);
  return result;
}

const pause = () => new Promise((r) => setTimeout(r, 1000));

// GitHub serves ref reads from replicas, so a push can take a few seconds to show; the next step waits for it.
async function branchAt(branch: string, pushOutput: string) {
  const sha = pushOutput.match(/commit\/([0-9a-f]{40})/)?.[1];
  const token = await installationToken(env, env.github!.installationId, REPO, { contents: "read" });
  for (let i = 0; i < 30; i++) {
    const ref = await githubCall(env, token, "GET", `/repos/${REPO}/git/ref/heads/${branch}`).catch(() => null);
    if (ref?.object.sha === sha) return;
    await pause();
  }
  throw new Error(`${branch} never showed ${sha}.`);
}

describe.skipIf(!process.env.REAL_TOOLS)("tools against the real services", () => {
  beforeAll(async () => {
    const keys = {
      tavilyKey: process.env.TAVILY_API_KEY,
      githubAppId: process.env.GITHUB_APP_ID,
      githubPrivateKey: readFileSync(resolve(ROOT, process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? ""), "utf8"),
    };
    env = {
      fetch, fetchPage: (url) => fetchPage(url), keys, mcpCall: () => Promise.reject(new Error("No MCP servers in this suite.")),
      room: { roomId: "r1", threadId: "t1", threadNumber: 1, runId: "run1", agentId: "agent", agentName: "agent", kinds: [], delegates: "all", tainted: false, postCap: 10 },
    };
  });

  afterAll(async () => {
    if (!env?.github) return;
    const cleanUp = async (what: string, permissions: Record<string, "write">, method: string, path: string, body?: unknown) => {
      try {
        const token = await installationToken(env, env.github!.installationId, REPO, permissions);
        await githubCall(env, token, method, `/repos/${REPO}${path}`, body);
        console.log(`cleaned up: ${what}`);
      } catch (e) {
        console.log(`couldn't clean up ${what}: ${(e as Error).message}`);
      }
    };
    if (openPr) await cleanUp(`closed PR #${openPr}`, { pull_requests: "write" }, "PATCH", `/pulls/${openPr}`, { state: "closed" });
    for (const branch of [HEAD, BASE]) await cleanUp(`deleted ${branch}`, { contents: "write" }, "DELETE", `/git/refs/heads/${branch}`);
    if (!labelExisted) await cleanUp(`deleted label ${LABEL}`, { issues: "write" }, "DELETE", `/labels/${LABEL}`);
  });

  it("searches the web and cites what it found", async () => {
    const r = await run("web_search", { query: "AWS Lambda durable functions callbacks" });
    expect(r.ok, r.output).toBe(true);
    expect(r.sources!.length).toBeGreaterThan(0);
    console.log(`web_search: ${r.sources!.length} sources, first ${r.sources![0]!.url}`);
  });

  it("fetches a public page and refuses the metadata address", async () => {
    const page = await run("web_fetch", { url: "https://example.com/" });
    expect(page.ok, page.output).toBe(true);
    expect(page.output).toContain("Example Domain");
    expect(await run("web_fetch", { url: "http://169.254.169.254/" })).toMatchObject({ ok: false });
  });

  it("finds the App's installation on the playground and reads the repo", async () => {
    const jwt = appJwt(env.keys.githubAppId!, env.keys.githubPrivateKey!);
    const installation = await githubCall(env, jwt, "GET", `/repos/${REPO}/installation`).catch(() => null);
    expect(installation, `The App isn't installed on ${REPO}.`).not.toBeNull();
    env = { ...env, github: { installationId: installation.id, account: installation.account.login, repos: [REPO], addedBy: "live", addedAt: "" } };

    expect(await run("github_read_file", { path: "README.md" })).toMatchObject({ ok: true });
    expect((await run("github_list", { kind: "issues", state: "all" })).ok).toBe(true);
    const missing = await run("github_read_file", { path: "no-such-file.txt" });
    expect(missing).toMatchObject({ ok: false, output: "GitHub couldn't find that, or the App can't see it." });
    // An error never carries an installation token or key text.
    expect(missing.output).not.toMatch(/gh[s]_|BEGIN/);

    const token = await installationToken(env, installation!.id, REPO, { issues: "read" });
    labelExisted = !!(await githubCall(env, token, "GET", `/repos/${REPO}/labels/${LABEL}`).catch(() => null));
  });

  it("pushes two branches, opens a PR between them, comments, labels and squash-merges it", async () => {
    const file = (name: string) => [{ path: `live/${STAMP}-${name}.md`, content: `Written by the chat-lite live suite at ${new Date().toISOString()}.\n` }];
    const base = await write("github_push_branch", { repo: REPO, branch: BASE, message: "Live suite: base", files: file("base") });
    expect(base.ok).toBe(true);
    await branchAt(BASE, base.output);
    const head = await write("github_push_branch", { repo: REPO, branch: HEAD, base: BASE, message: "Live suite: head", files: file("head") });
    expect(head.ok).toBe(true);
    await branchAt(HEAD, head.output);

    const opened = await write("github_create_pr", { repo: REPO, title: `chat-lite live test ${STAMP}`, head: HEAD, base: BASE, body: "Opened by a test." });
    expect(opened.ok).toBe(true);
    const pr = Number(opened.output.match(/#(\d+)/)?.[1]);
    openPr = pr;

    expect(await write("github_comment", { repo: REPO, number: pr, body: "hello from the chat-lite live suite" })).toMatchObject({ ok: true });
    const labelled = await write("github_add_labels", { repo: REPO, number: pr, labels: [LABEL] });
    expect(labelled).toMatchObject({ ok: true, output: expect.stringContaining(LABEL) });

    // GitHub works out a new PR's mergeability in the background, and refuses a merge (405) until it has.
    let merged = await write("github_merge_pr", { repo: REPO, number: pr, method: "squash" });
    for (let i = 0; i < 10 && !merged.ok && merged.output.includes("405"); i++) {
      await pause();
      merged = await write("github_merge_pr", { repo: REPO, number: pr, method: "squash" });
    }
    expect(merged.ok).toBe(true);
    openPr = undefined;

    const read = await run("github_get", { number: pr });
    expect(read.output).toContain(`${HEAD} → ${BASE} · merged`);
    expect(read.output).toContain("hello from the chat-lite live suite");
  });
});
