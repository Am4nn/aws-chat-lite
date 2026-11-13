import { describe, expect, it, vi } from "vitest";
import type { GitHubConnection } from "../../threads/types.js";
import { fakeKeys, type GitHubCall, recordGitHub } from "../fake-github.js";
import type { Tool, ToolEnv } from "../types.js";
import { GITHUB_TOOLS } from "./tools.js";

const conn: GitHubConnection = { installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "u1", addedAt: "2026-11-11T00:00:00Z" };
const READ_SET = { metadata: "read", contents: "read", issues: "read", pull_requests: "read" };

function setup(answer?: (call: GitHubCall) => Response | undefined) {
  const { calls, fetch } = recordGitHub(answer);
  const env: ToolEnv = {
    fetch, fetchPage: () => Promise.reject(new Error("no pages")), keys: fakeKeys(), github: conn,
    mcpCall: () => Promise.reject(new Error("not wired")), room: { roomId: "r1", threadId: "t1", threadNumber: 1, runId: "run1", agentId: "agent", agentName: "agent", kinds: [], delegates: "all", tainted: false, postCap: 10 },
  };
  return { calls, env, repoCalls: () => calls.filter((c) => c.path.startsWith("/repos/")).map((c) => `${c.method} ${c.path}`) };
}
const tool = (name: string): Tool => GITHUB_TOOLS.find((t) => t.spec.name === name)!;
const minted = (calls: GitHubCall[]) => calls.find((c) => c.path.endsWith("/access_tokens"))?.body;

describe("GITHUB_TOOLS", () => {
  it("are the nine GitHub tools, with only the reads unmarked as writes", () => {
    expect(GITHUB_TOOLS.map((t) => [t.spec.name, t.write])).toEqual([
      ["github_list", false],
      ["github_get", false],
      ["github_read_file", false],
      ["github_comment", true],
      ["github_create_issue", true],
      ["github_add_labels", true],
      ["github_push_branch", true],
      ["github_create_pr", true],
      ["github_merge_pr", true],
    ]);
    for (const t of GITHUB_TOOLS) {
      expect(t.spec.name).toMatch(/^[a-z_]{1,64}$/);
      expect(t.kind).toBe("github");
    }
  });

  it("refuses a repo outside the connection before any call", () => {
    const { env, calls } = setup();
    expect(tool("github_comment").check!({ repo: "other/x", number: 1, body: "b" }, env)).toBe(
      "other/x isn't connected to this room. Connected: fake-org/playground.",
    );
    expect(calls).toEqual([]);
  });

  it("checks the required fields", () => {
    const { env } = setup();
    expect(tool("github_comment").check!({ number: 1 }, env)).toBe('Missing or invalid "body".');
    expect(tool("github_list").check!({ kind: "commits" }, env)).toBe('Missing or invalid "kind".');
    expect(tool("github_comment").check!({ number: 1, body: "b" }, env)).toBeNull();
  });

  it("mints a token scoped to the one repo with each tool's permissions", async () => {
    const read = setup();
    expect((await tool("github_read_file").run({ path: "README.md" }, read.env)).ok).toBe(true);
    expect(minted(read.calls)).toEqual({ repositories: ["playground"], permissions: READ_SET });

    const merge = setup();
    expect((await tool("github_merge_pr").run({ number: 2, method: "squash" }, merge.env)).ok).toBe(true);
    expect(minted(merge.calls)).toEqual({ repositories: ["playground"], permissions: { contents: "write", pull_requests: "write" } });
    expect(merge.calls.at(-1)).toMatchObject({ method: "PUT", path: "/repos/fake-org/playground/pulls/2/merge", body: { merge_method: "squash" } });

    // GitHub refuses to open a PR ("not all refs are readable") with a token that can't read the branches.
    const pr = setup();
    expect((await tool("github_create_pr").run({ title: "t", head: "feature" }, pr.env)).ok).toBe(true);
    expect(minted(pr.calls)).toEqual({ repositories: ["playground"], permissions: { contents: "read", pull_requests: "write" } });
  });

  it("asks with each write's exact title", () => {
    const { env } = setup();
    const titles = [
      ["github_comment", { number: 4, body: "b" }, "Comment on #4 in fake-org/playground?"],
      ["github_create_issue", { title: "Bug" }, 'Open an issue "Bug" in fake-org/playground?'],
      ["github_add_labels", { number: 4, labels: ["a", "b"] }, "Add labels a, b to #4 in fake-org/playground?"],
      ["github_push_branch", { branch: "b", message: "m", files: [{ path: "x", content: "y" }] }, "Push 1 file(s) to b in fake-org/playground?"],
      ["github_create_pr", { title: "T", head: "b", base: "main" }, "Open a PR b → main in fake-org/playground?"],
      ["github_merge_pr", { number: 4, method: "squash" }, "Merge PR #4 in fake-org/playground (squash)?"],
    ] as const;
    for (const [name, input, title] of titles) expect(tool(name).ask!(input, env)).toBe(title);
  });

  describe("github_push_branch", () => {
    const files = [{ path: "notes.md", content: "hi" }];

    it("makes one commit on top of the base and creates the new branch", async () => {
      const { env, calls, repoCalls } = setup();
      const result = await tool("github_push_branch").run({ branch: "topic", message: "Add notes", files }, env);

      expect(result).toEqual({ ok: true, output: "Pushed 1 file(s) to topic as sha-com: https://github.com/fake-org/playground/commit/sha-commit-0001" });
      expect(repoCalls().filter((c) => c.includes("/git/"))).toEqual([
        "GET /repos/fake-org/playground/git/ref/heads/topic",
        "GET /repos/fake-org/playground/git/ref/heads/main",
        "POST /repos/fake-org/playground/git/trees",
        "POST /repos/fake-org/playground/git/commits",
        "POST /repos/fake-org/playground/git/refs",
      ]);
      const body = (suffix: string) => calls.find((c) => c.method === "POST" && c.path.endsWith(suffix))?.body;
      expect(body("/git/trees")).toEqual({ base_tree: "sha-main", tree: [{ path: "notes.md", mode: "100644", type: "blob", content: "hi" }] });
      expect(body("/git/commits")).toEqual({ message: "Add notes", tree: "sha-tree", parents: ["sha-main"] });
      expect(body("/git/refs")).toEqual({ ref: "refs/heads/topic", sha: "sha-commit-0001" });
    });

    it("fast-forwards an existing branch, never forcing it", async () => {
      const { env, calls } = setup();
      expect((await tool("github_push_branch").run({ branch: "feature", message: "m", files }, env)).ok).toBe(true);
      expect(calls.find((c) => c.path.endsWith("/git/commits"))?.body.parents).toEqual(["sha-feature"]);
      expect(calls.at(-1)).toEqual({
        method: "PATCH",
        path: "/repos/fake-org/playground/git/refs/heads/feature",
        body: { sha: "sha-commit-0001", force: false },
      });
    });

    it("says to try again when the branch appears between the check and the create", async () => {
      const { env } = setup((c) => (c.path.endsWith("/git/refs") ? Response.json({ message: "Reference already exists" }, { status: 422 }) : undefined));
      expect(await tool("github_push_branch").run({ branch: "topic", message: "m", files }, env)).toEqual({
        ok: false,
        output: "topic turned out to exist already, so nothing was pushed. Try again in a moment.",
      });
    });

    it.each([
      "main/", "./main", "x/../main", "x/../../tags/v1", "/main", "a//b", "", ".", "..", "a/.hidden", "a.lock", "a/b.lock/c",
      "a.", "a b", "a\u0000b", "a\tb", "a\u007fb", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a@{1}", "@",
    ])("refuses the ref name %j before anyone is asked, and never calls GitHub with it", async (branch) => {
      const { env, repoCalls } = setup();
      const input = { branch, message: "m", files };
      expect(tool("github_push_branch").check!(input, env)).toBe('"branch" isn\'t a valid git ref name.');
      expect((await tool("github_push_branch").run(input, env)).ok).toBe(false);
      expect(repoCalls()).toEqual([]);
    });

    it("refuses a bad base the same way", () => {
      const { env } = setup();
      expect(tool("github_push_branch").check!({ branch: "topic", base: "x/../main", message: "m", files }, env)).toBe(
        '"base" isn\'t a valid git ref name.',
      );
    });

    it("pushes a nested branch name as it is", async () => {
      const { env, repoCalls } = setup();
      expect((await tool("github_push_branch").run({ branch: "feat/a-1.2", message: "m", files }, env)).ok).toBe(true);
      expect(repoCalls()).toContain("GET /repos/fake-org/playground/git/ref/heads/feat/a-1.2");
    });

    it("refuses the default branch", async () => {
      const { env } = setup((c) => (c.path === "/repos/fake-org/playground" ? Response.json({ default_branch: "trunk" }) : undefined));
      expect(tool("github_push_branch").check!({ branch: "main", message: "m", files }, env)).toBe("Push to a new branch, then open a PR.");
      expect(await tool("github_push_branch").run({ branch: "trunk", message: "m", files }, env)).toEqual({
        ok: false,
        output: "Push to a new branch, then open a PR.",
      });
    });
  });

  describe("github_read_file", () => {
    it.each(["../../other/x/contents/a", "a/../../../x", "./a", "a/./b", "a\u0000b", "a\nb"])(
      "refuses the path %j, so it can't climb out of the repo's contents",
      async (path) => {
        const { env, repoCalls } = setup();
        expect(tool("github_read_file").check!({ path }, env)).toBe('"path" can\'t have . or .. segments or control characters.');
        expect((await tool("github_read_file").run({ path }, env)).ok).toBe(false);
        expect(repoCalls()).toEqual([]);
      },
    );

    it("refuses a ref that isn't a valid git ref name", () => {
      const { env } = setup();
      expect(tool("github_read_file").check!({ path: "README.md", ref: "../main" }, env)).toBe('"ref" isn\'t a valid git ref name.');
      expect(tool("github_read_file").check!({ path: "src/a.ts", ref: "v1.2" }, env)).toBeNull();
    });
  });

  it("answers a failure in our words, never GitHub's or the network's, and logs the cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const pem = fakeKeys().githubPrivateKey;
    const { env } = setup((c) =>
      c.path.includes("/contents/") ? Response.json({ message: `boom ghs_fake ${pem}` }, { status: 500 }) : undefined,
    );
    expect(await tool("github_read_file").run({ path: "README.md" }, env)).toEqual({ ok: false, output: "GitHub is having trouble; try again later." });
    const arn = new Error("User: arn:aws:sts::123456789012:assumed-role/x is not authorized");
    const offline = { ...env, fetch: (async () => { throw arn; }) as typeof fetch };
    expect(await tool("github_read_file").run({ path: "README.md" }, offline)).toEqual({ ok: false, output: "GitHub couldn't be reached." });
    expect(logged.mock.calls.flat()).toContain(arn);
    logged.mockRestore();
  });

  it("cuts each PR patch at 3,000 characters", async () => {
    const patch = "x".repeat(10_000);
    const { env } = setup((c) =>
      c.path.includes("/pulls/2/files") ? Response.json([{ filename: "big.txt", status: "added", additions: 1, deletions: 0, patch }]) : undefined,
    );
    const result = await tool("github_get").run({ number: 2 }, env);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`${"x".repeat(3000)}\n…(cut)`);
    expect(result.output).not.toContain("x".repeat(3001));
  });

  it("reads issues, PRs and files as compact text", async () => {
    const { env } = setup();
    const run = async (name: string, input: Record<string, unknown>) => (await tool(name).run(input, env)).output;

    expect(await run("github_list", { kind: "issues" })).toBe("#1 [open] The README is short (octocat; docs)");
    expect(await run("github_list", { kind: "pulls", state: "all" })).toBe("#2 [open] Add a greeting (octocat; docs)");
    expect(await run("github_get", { number: 2 })).toContain("PR #2 [open] Add a greeting\nby octocat · feature → main");
    expect(await run("github_get", { number: 1 })).toContain("Comments (1):\noctocat, 2026-11-01: Looks good.");
    expect(await run("github_read_file", { path: "README.md" })).toBe("README.md\n\n# Playground\n\nA fake repo for tests.\n");
    expect(await run("github_read_file", { path: "/" })).toBe("README.md\nsrc/");
  });
});
