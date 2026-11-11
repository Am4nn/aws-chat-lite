import { describe, expect, it } from "vitest";
import { findTool, roomTools, toolEnv } from "./index.js";

const names = (opts: { connected: boolean; privateOk: boolean }) => roomTools(opts).map((t) => t.spec.name);
const github = { installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "aman", addedAt: "2026-11-11T00:00:00Z" };

describe("roomTools", () => {
  it("offers the web tools always and GitHub's only with a connection and a model that may see private content", () => {
    expect(names({ connected: false, privateOk: true })).toEqual(["web_search", "web_fetch"]);
    expect(names({ connected: true, privateOk: false })).toEqual(["web_search", "web_fetch"]);
    const all = names({ connected: true, privateOk: true });
    expect(all.filter((n) => n.startsWith("github_"))).toHaveLength(9);
  });

  it("finds a tool by name", () => {
    expect(findTool("github_comment")?.write).toBe(true);
    expect(findTool("sandbox_run")).toBeUndefined();
  });
});

describe("toolEnv in fake mode", () => {
  it("answers web search with two sources", async () => {
    const env = await toolEnv("fake");
    const result = await findTool("web_search")!.run({ query: "q" }, env);
    expect(result.ok).toBe(true);
    expect(result.sources).toHaveLength(2);
  });

  it("runs the GitHub tools against the canned App, signed with its own key", async () => {
    const env = await toolEnv("fake", github);
    const result = await findTool("github_read_file")!.run({ path: "README.md" }, env);
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining("# Playground") });
  });

  it("fetches pages without the network, still refusing private addresses", async () => {
    const env = await toolEnv("fake");
    expect((await findTool("web_fetch")!.run({ url: "https://example.com/" }, env)).output).toContain("Fake page");
    expect((await findTool("web_fetch")!.run({ url: "http://169.254.169.254/" }, env)).ok).toBe(false);
  });
});
