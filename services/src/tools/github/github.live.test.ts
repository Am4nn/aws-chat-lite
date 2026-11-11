import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolEnv } from "../types.js";
import { githubCall, installationToken, listInstallations } from "./app.js";
import { GITHUB_TOOLS } from "./tools.js";

// Real calls through the GitHub App, opt-in: REAL_TOOLS=1 npm -w services run test:live -- tools/github
// They only ever touch the playground repo, and every write lands on a throwaway branch that the suite deletes.
const REPO = "Am4nn/chat-lite-playground";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BRANCH = `chat-lite-test-${Date.now()}`;

const run = (name: string, input: Record<string, unknown>) => GITHUB_TOOLS.find((t) => t.spec.name === name)!.run(input, env);
let env: ToolEnv;
let pr: number | undefined;

// GitHub serves ref reads from replicas, so a push can take a few seconds to show; the next step waits for it.
async function branchAt(pushOutput: string) {
  const sha = pushOutput.match(/commit\/([0-9a-f]{40})/)?.[1];
  const token = await installationToken(env, env.github!.installationId, REPO, { contents: "read" });
  for (let i = 0; i < 30; i++) {
    const ref = await githubCall(env, token, "GET", `/repos/${REPO}/git/ref/heads/${BRANCH}`).catch(() => null);
    if (ref?.object.sha === sha) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${BRANCH} never showed ${sha}.`);
}

describe.skipIf(!process.env.REAL_TOOLS)("GitHub tools on the playground repo", () => {
  beforeAll(async () => {
    const keys = {
      githubAppId: process.env.GITHUB_APP_ID,
      githubPrivateKey: readFileSync(resolve(ROOT, process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? ""), "utf8"),
    };
    const base = { fetch, fetchPage: () => Promise.reject(new Error("no pages")), keys };
    const installation = (await listInstallations(base)).find((i) => i.repos.includes(REPO));
    if (!installation) throw new Error(`The App isn't installed on ${REPO}.`);
    env = {
      ...base, github: { installationId: installation.id, account: installation.account, repos: [REPO], addedBy: "live", addedAt: "" },
      mcpCall: () => Promise.reject(new Error("not wired")),
    };
  });

  afterAll(async () => {
    if (!env) return;
    const cleanUp = async (what: string, permissions: Record<string, "write">, method: string, path: string, body?: unknown) => {
      try {
        const token = await installationToken(env, env.github!.installationId, REPO, permissions);
        await githubCall(env, token, method, `/repos/${REPO}${path}`, body);
        console.log(`cleaned up: ${what}`);
      } catch (e) {
        console.log(`couldn't clean up ${what}: ${(e as Error).message}`);
      }
    };
    if (pr) await cleanUp(`closed PR #${pr}`, { pull_requests: "write" }, "PATCH", `/pulls/${pr}`, { state: "closed" });
    await cleanUp(`deleted ${BRANCH}`, { contents: "write" }, "DELETE", `/git/refs/heads/${BRANCH}`);
  });

  it("reads the repo", async () => {
    const readme = await run("github_read_file", { path: "README.md" });
    expect(readme.ok).toBe(true);
    expect((await run("github_read_file", { path: "/" })).output).toContain("README.md");
    expect((await run("github_list", { kind: "issues", state: "all" })).ok).toBe(true);

    const missing = await run("github_read_file", { path: "no-such-file.txt" });
    expect(missing).toMatchObject({ ok: false, output: expect.stringMatching(/^GitHub said 404/) });
    expect(missing.output).not.toMatch(/ghs_|BEGIN/);
  });

  it("pushes to a new branch, fast-forwards it, and opens a PR from it", async () => {
    const files = [{ path: "chat-lite-test.txt", content: `Written by the chat-lite live suite at ${new Date().toISOString()}.\n` }];
    const created = await run("github_push_branch", { branch: BRANCH, message: "Live suite: new branch", files });
    console.log(created.output);
    expect(created.ok).toBe(true);
    await branchAt(created.output);
    const forwarded = await run("github_push_branch", { branch: BRANCH, message: "Live suite: fast-forward", files: [{ ...files[0], content: "Again.\n" }] });
    console.log(forwarded.output);
    expect(forwarded.ok).toBe(true);
    await branchAt(forwarded.output);

    const opened = await run("github_create_pr", { title: "chat-lite live suite (closes itself)", head: BRANCH, body: "Opened and closed by a test." });
    console.log(opened.output);
    expect(opened.ok).toBe(true);
    pr = Number(opened.output.match(/#(\d+)/)?.[1]);

    // GitHub works out a new PR's files in the background.
    let read = await run("github_get", { number: pr });
    for (let i = 0; i < 20 && !read.output.includes("chat-lite-test.txt"); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      read = await run("github_get", { number: pr });
    }
    expect(read.ok).toBe(true);
    expect(read.output).toContain("chat-lite-test.txt");
  });
});
