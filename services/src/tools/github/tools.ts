import { cut } from "../cut.js";
import type { Tool, ToolEnv } from "../types.js";
import { GitHubError, githubCall, installationToken, type Permissions } from "./app.js";
import { repoOf } from "./repo.js";

type Input = Record<string, any>;
/** A REST call on the tool's one repo, with its scoped token. */
type RepoCall = (method: string, path: string, body?: unknown) => Promise<any>;
type Schema = { type: string; description?: string; enum?: string[]; minimum?: number; minItems?: number; items?: Schema; properties?: Record<string, Schema>; required?: string[] };

type GitHubToolDef = {
  name: string;
  description: string;
  properties: Record<string, Schema>;
  required: string[];
  permissions: Permissions;
  detail(input: Input): string;
  /** Present on writes: the approval title. */
  ask?(input: Input, repo: string): string;
  check?(input: Input): string | null;
  call(gh: RepoCall, input: Input, repo: string): Promise<string>;
};

const READ_SET: Permissions = { metadata: "read", contents: "read", issues: "read", pull_requests: "read" };
const MAX_PATCH = 3_000;
const DEFAULT_BRANCH_REFUSED = "Push to a new branch, then open a PR.";
// Installation tokens, personal tokens, JWTs and PEM blocks, in case GitHub echoes a credential back in an error.
const SECRET = /gh[opsu]_\w+|github_pat_\w+|eyJ[\w-]+\.[\w-]+\.[\w-]+|-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g;

const inRepo = (input: Input) => (input.repo ? ` in ${input.repo}` : "");

/**
 * Git's own ref-name rules. A name that breaks them could read two ways: the URL parser resolves "." and ".."
 * segments and GitHub drops empty ones, so "main/" or "x/../main" would reach the default branch's ref, or another
 * endpoint, while the approval showed something else.
 */
const validRef = (name: string) =>
  !/\.\.|@\{|[\x00-\x20\x7f~^:?*[\\]|\.$/.test(name) && name !== "@"
  && name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
const refError = (input: Input, ...keys: string[]) => {
  const bad = keys.find((key) => input[key] !== undefined && !validRef(input[key]));
  return bad ? `"${bad}" isn't a valid git ref name.` : null;
};

const REPO: Schema = { type: "string", description: "owner/name; optional when the room has one repo connected" };
const NUMBER: Schema = { type: "integer", minimum: 1, description: "issue or PR number" };
const LABELS: Schema = { type: "array", minItems: 1, items: { type: "string" } };

function valid(schema: Schema, value: any): boolean {
  switch (schema.type) {
    case "string":
      return typeof value === "string" && (!schema.enum || schema.enum.includes(value));
    case "integer":
      return Number.isInteger(value) && value >= (schema.minimum ?? -Infinity);
    case "array":
      return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.every((v) => valid(schema.items!, v));
    default:
      return typeof value === "object" && value !== null && (schema.required ?? []).every((k) => valid(schema.properties![k], value[k]));
  }
}

function checkInput(def: GitHubToolDef, input: Input, env: ToolEnv): string | null {
  const repo = repoOf(input, env.github);
  if (typeof repo !== "string") return repo.error;
  for (const [key, schema] of Object.entries(def.properties)) {
    const present = input[key] !== undefined;
    if ((present || def.required.includes(key)) && !valid(schema, input[key])) return `Missing or invalid "${key}".`;
  }
  return def.check?.(input) ?? null;
}

function githubTool(def: GitHubToolDef): Tool {
  const { name, description, properties, required } = def;
  return {
    spec: { name, description, inputSchema: { type: "object", properties: { repo: REPO, ...properties }, required } },
    kind: "github",
    write: def.ask !== undefined,
    detail: def.detail,
    check: (input, env) => checkInput(def, input, env),
    ask: def.ask && ((input, env) => def.ask!(input, String(repoOf(input, env.github)))),
    async run(input, env) {
      const refused = checkInput(def, input, env);
      if (refused) return { ok: false, output: refused };
      const repo = repoOf(input, env.github) as string;
      try {
        const token = await installationToken(env, env.github!.installationId, repo, def.permissions);
        const gh: RepoCall = (method, path, body) => githubCall(env, token, method, `/repos/${repo}${path}`, body);
        return { ok: true, output: cut(await def.call(gh, input, repo)) };
      } catch (e) {
        const message = e instanceof GitHubError ? e.message : `GitHub couldn't be reached (${(e as Error).message}).`;
        return { ok: false, output: message.replace(SECRET, "[redacted]") };
      }
    },
  };
}

type Item = { number: number; title: string; state: string; user: { login: string }; labels: { name: string }[] };
const itemLine = (i: Item) =>
  `#${i.number} [${i.state}] ${i.title} (${i.user.login}${i.labels.length ? `; ${i.labels.map((l) => l.name).join(", ")}` : ""})`;

const encodePath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
const defaultBranch = async (gh: RepoCall): Promise<string> => (await gh("GET", "")).default_branch;

async function readFile(gh: RepoCall, { path, ref }: Input): Promise<string> {
  const data = await gh("GET", `/contents/${encodePath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
  if (Array.isArray(data)) return data.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n") || "(empty directory)";
  if (data.type !== "file") return `${data.path} is a ${data.type}, not a file.`;
  // The contents API leaves content out of files over 1 MB.
  if (data.encoding !== "base64") return `${data.path} is too big to read here (${data.size} bytes).`;
  const text = Buffer.from(data.content, "base64").toString("utf8");
  return text.includes("\u0000") ? `${data.path} is a binary file (${data.size} bytes).` : `${data.path}\n\n${text}`;
}

async function getItem(gh: RepoCall, { number }: Input): Promise<string> {
  const item = await gh("GET", `/issues/${number}`);
  const comments: { user: { login: string }; created_at: string; body: string }[] = await gh("GET", `/issues/${number}/comments?per_page=50`);
  const lines = [`${item.pull_request ? "PR" : "Issue"} #${number} [${item.state}] ${item.title}`];
  const pr = item.pull_request && (await gh("GET", `/pulls/${number}`));
  lines.push(pr ? `by ${item.user.login} · ${pr.head.ref} → ${pr.base.ref}${pr.merged ? " · merged" : ""}` : `by ${item.user.login}`);
  if (item.labels.length) lines.push(`labels: ${item.labels.map((l: { name: string }) => l.name).join(", ")}`);
  lines.push(item.html_url, "", item.body || "(no description)", "", `Comments (${comments.length}):`);
  lines.push(...comments.map((c) => `${c.user.login}, ${c.created_at.slice(0, 10)}: ${c.body}`));
  if (pr) {
    const files: { filename: string; status: string; additions: number; deletions: number; patch?: string }[] = await gh(
      "GET",
      `/pulls/${number}/files?per_page=100`,
    );
    lines.push("", `Files (${files.length}):`);
    for (const f of files) lines.push(`${f.filename} (${f.status}, +${f.additions} −${f.deletions})`, cut(f.patch ?? "(no patch)", MAX_PATCH));
  }
  return lines.join("\n");
}

/**
 * One commit through the Git Data API, so any number of files land atomically without a clone. The ref update never
 * forces: if the branch moved since we read it, GitHub refuses rather than dropping someone's commits.
 */
async function pushBranch(gh: RepoCall, { branch, base, message, files }: Input): Promise<string> {
  const main = await defaultBranch(gh);
  if (branch === main) throw new GitHubError(DEFAULT_BRANCH_REFUSED);
  const head = (name: string) => gh("GET", `/git/ref/heads/${encodePath(name)}`).then((ref) => ref.object.sha as string);
  const existing = await head(branch).catch((e) => {
    if (e instanceof GitHubError && e.message.startsWith("GitHub said 404")) return undefined;
    throw e;
  });
  const parent = existing ?? (await head(base ?? main));
  const tree = await gh("POST", "/git/trees", {
    base_tree: parent,
    tree: files.map((f: { path: string; content: string }) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
  });
  const commit = await gh("POST", "/git/commits", { message, tree: tree.sha, parents: [parent] });
  if (existing) await gh("PATCH", `/git/refs/heads/${encodePath(branch)}`, { sha: commit.sha, force: false });
  else {
    // GitHub reads refs from replicas, so a branch made seconds ago can still look missing; the create then fails
    // and nothing has moved.
    await gh("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha }).catch((e) => {
      if (e instanceof GitHubError && e.message.startsWith("GitHub said 422")) {
        throw new GitHubError(`${branch} turned out to exist already, so nothing was pushed. Try again in a moment.`);
      }
      throw e;
    });
  }
  return `Pushed ${files.length} file(s) to ${branch} as ${commit.sha.slice(0, 7)}: ${commit.html_url}`;
}

export const GITHUB_TOOLS: Tool[] = [
  githubTool({
    name: "github_list",
    description: "Lists a repo's issues or pull requests, newest first (up to 30).",
    properties: { kind: { type: "string", enum: ["issues", "pulls"] }, state: { type: "string", enum: ["open", "closed", "all"] } },
    required: ["kind"],
    permissions: READ_SET,
    detail: (input) => `Listing ${input.state ?? "open"} ${input.kind}${inRepo(input)}`,
    async call(gh, { kind, state = "open" }, repo) {
      const items: (Item & { pull_request?: unknown })[] = await gh("GET", `/${kind}?state=${state}&per_page=30`);
      // The issues endpoint returns pull requests too.
      const lines = items.filter((i) => kind === "pulls" || !i.pull_request).map(itemLine);
      return lines.join("\n") || `No ${state} ${kind} in ${repo}.`;
    },
  }),
  githubTool({
    name: "github_get",
    description: "Reads one issue or pull request with its comments; for a PR, also its changed files and patches.",
    properties: { number: NUMBER },
    required: ["number"],
    permissions: READ_SET,
    detail: (input) => `Reading #${input.number}${inRepo(input)}`,
    call: getItem,
  }),
  githubTool({
    name: "github_read_file",
    description: "Reads a file from a repo, or lists a directory (use / for the root).",
    properties: { path: { type: "string" }, ref: { type: "string", description: "branch, tag or commit; the default branch if omitted" } },
    required: ["path"],
    permissions: READ_SET,
    detail: (input) => `Reading ${input.path}${inRepo(input)}`,
    check: (input) =>
      input.path.split("/").some((part: string) => part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(input.path)
        ? `"path" can't have . or .. segments or control characters.`
        : refError(input, "ref"),
    call: readFile,
  }),
  githubTool({
    name: "github_comment",
    description: "Comments on an issue or pull request. Waits for a room member's approval.",
    properties: { number: NUMBER, body: { type: "string" } },
    required: ["number", "body"],
    permissions: { issues: "write", pull_requests: "write" },
    detail: (input) => `Commenting on #${input.number}${inRepo(input)}`,
    ask: ({ number }, repo) => `Comment on #${number} in ${repo}?`,
    async call(gh, { number, body }) {
      return `Commented on #${number}: ${(await gh("POST", `/issues/${number}/comments`, { body })).html_url}`;
    },
  }),
  githubTool({
    name: "github_create_issue",
    description: "Opens an issue. Waits for a room member's approval.",
    properties: { title: { type: "string" }, body: { type: "string" }, labels: LABELS },
    required: ["title"],
    permissions: { issues: "write" },
    detail: (input) => `Opening issue "${input.title}"${inRepo(input)}`,
    ask: ({ title }, repo) => `Open an issue "${title}" in ${repo}?`,
    async call(gh, { title, body, labels }) {
      const issue = await gh("POST", "/issues", { title, body, labels });
      return `Opened issue #${issue.number}: ${issue.html_url}`;
    },
  }),
  githubTool({
    name: "github_add_labels",
    description: "Adds labels to an issue or pull request. Waits for a room member's approval.",
    properties: { number: NUMBER, labels: LABELS },
    required: ["number", "labels"],
    permissions: { issues: "write", pull_requests: "write" },
    detail: (input) => `Labelling #${input.number}${inRepo(input)}`,
    ask: ({ number, labels }, repo) => `Add labels ${labels.join(", ")} to #${number} in ${repo}?`,
    async call(gh, { number, labels }) {
      const now: { name: string }[] = await gh("POST", `/issues/${number}/labels`, { labels });
      return `#${number} now has labels: ${now.map((l) => l.name).join(", ")}`;
    },
  }),
  githubTool({
    name: "github_push_branch",
    description:
      "Commits files to a branch in one commit, creating the branch from base (default: the default branch) if it's new. Never the default branch; open a PR instead. Waits for a room member's approval.",
    properties: {
      branch: { type: "string" },
      base: { type: "string" },
      message: { type: "string", description: "the commit message" },
      files: {
        type: "array",
        minItems: 1,
        items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      },
    },
    required: ["branch", "message", "files"],
    permissions: { contents: "write" },
    detail: (input) => `Pushing ${input.files?.length} file(s) to ${input.branch}${inRepo(input)}`,
    ask: ({ branch, files }, repo) => `Push ${files.length} file(s) to ${branch} in ${repo}?`,
    // The connection doesn't know each repo's default branch, so the usual names are refused here, before anyone is
    // asked, and the real one again when the push runs.
    check: (input) => refError(input, "branch", "base") ?? (["main", "master"].includes(input.branch) ? DEFAULT_BRANCH_REFUSED : null),
    call: pushBranch,
  }),
  githubTool({
    name: "github_create_pr",
    description: "Opens a pull request from head into base (default: the default branch). Waits for a room member's approval.",
    properties: { title: { type: "string" }, head: { type: "string" }, base: { type: "string" }, body: { type: "string" } },
    required: ["title", "head"],
    permissions: { pull_requests: "write" },
    detail: (input) => `Opening a PR from ${input.head}${inRepo(input)}`,
    ask: ({ head, base }, repo) => `Open a PR ${head} → ${base ?? "the default branch"} in ${repo}?`,
    async call(gh, { title, head, base, body }) {
      const into = base ?? (await defaultBranch(gh));
      const pr = await gh("POST", "/pulls", { title, head, base: into, body });
      return `Opened PR #${pr.number} ${head} → ${into}: ${pr.html_url}`;
    },
  }),
  githubTool({
    name: "github_merge_pr",
    description: "Merges a pull request. Waits for a room member's approval.",
    properties: { number: NUMBER, method: { type: "string", enum: ["merge", "squash", "rebase"] } },
    required: ["number"],
    permissions: { contents: "write", pull_requests: "write" },
    detail: (input) => `Merging PR #${input.number}${inRepo(input)}`,
    ask: ({ number, method = "merge" }, repo) => `Merge PR #${number} in ${repo} (${method})?`,
    async call(gh, { number, method = "merge" }) {
      const merged = await gh("PUT", `/pulls/${number}/merge`, { merge_method: method });
      return `Merged PR #${number} (${method}): ${merged.sha.slice(0, 7)}`;
    },
  }),
];
