import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import type { RunEvent } from "../threads/types.js";
import { delegateResult, helperKinds, noSuchAgent, startHelper } from "./helpers.js";
import type { RoutedRun } from "./steps.js";
import { agentCard } from "./tools.js";

const runs = {
  allEvents: vi.fn(async (): Promise<RunEvent[]> => []),
  eventWriter: vi.fn(async () => ({ append: async (e: object) => ({ ...e, seq: 1, at: new Date().toISOString() }) })),
  progress: vi.fn(async () => ({})),
  stepDone: vi.fn(async () => ({})),
  recorded: vi.fn(),
};
const threads = { threadById: vi.fn() };
const agents = { byId: vi.fn() };
vi.mock("../agents/repo.js", () => ({ agentsRepo: () => agents }));
vi.mock("./repo.js", () => ({ runsRepo: () => runs }));
vi.mock("./notify.js", () => ({ notifyRun: async () => {} }));
vi.mock("./start.js", () => ({ roomDefaultModel: async () => "deepseek-flash" }));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => threads }));
vi.mock("./steps.js", async (importOriginal) => ({ ...await importOriginal<object>(), limitsReached: async () => null }));

describe("delegateResult", () => {
  it("is the helper's whole answer when it finished", () => {
    expect(delegateResult("researcher", { status: "done" }, "Found 3 docs.\n\nDetails.")).toEqual({ ok: true, output: "Found 3 docs.\n\nDetails." });
  });

  it("cuts an answer past 20,000 characters, by code point, and says so", () => {
    const { output } = delegateResult("researcher", { status: "done" }, "😀".repeat(20_001));
    expect(output).toBe(`${"😀".repeat(20_000)}\n…(cut)`);
  });

  it("says why a helper that didn't finish has no answer", () => {
    expect(delegateResult("researcher", { status: "stopped", reason: "Stopped by bea." }, "Half")).toEqual({
      ok: false, output: "@researcher couldn't finish: Stopped by bea.",
    });
  });
});

it("an agent the room doesn't have is refused with the ones it does", () => {
  const scout = { ...BUILT_IN, agentId: "a1", name: "scout", builtIn: false };
  expect(noSuchAgent("nobody", [BUILT_IN, scout])).toBe("There's no @nobody in this room. Agents: @agent, @scout.");
});

describe("helperKinds", () => {
  it("keeps every kind for a helper whose answer goes to a model that may see private content", () => {
    expect(helperKinds(["github", "mcp", "sandbox", "web"], "claude-sonnet-5-5")).toEqual(["github", "mcp", "sandbox", "web"]);
  });

  it("keeps only the web and images for a helper working for DeepSeek, so its results never make the thread private", () => {
    expect(helperKinds(["github", "images", "mcp", "sandbox", "web"], "deepseek-flash")).toEqual(["images", "web"]);
  });
});

describe("startHelper", () => {
  const researcher = {
    ...BUILT_IN, agentId: "a1", name: "researcher", builtIn: false, model: "room" as const, tools: [], instructions: "Find sources.\nCite them.",
  };
  const run = {
    runId: "run1", roomId: "r1", threadId: "t1", number: 1, agentId: "agent", status: "running", pick: "sonnet", pickBy: "pick",
    model: "claude-sonnet-5-5", startedBy: "aman", startedAt: "2026-11-12T00:00:00.000Z", deadAt: "2026-11-12T01:00:00.000Z",
    firstSeq: 1, seenSeq: 1, steps: 1, costMicros: 0, agent: BUILT_IN, others: [agentCard(researcher)],
  } satisfies RoutedRun;
  const call = { id: "c1", name: "delegate", input: { agent: "researcher", task: "Look it up." } };

  beforeEach(() => {
    vi.clearAllMocks();
    threads.threadById.mockResolvedValue({ taint: [] });
    agents.byId.mockResolvedValue(researcher);
    runs.recorded.mockResolvedValue({ model: "claude-haiku-5-5", by: "auto", costMicros: 0 });
  });

  it("keeps a helper on the room's DeepSeek default in a clean thread", async () => {
    const handover = await startHelper(run, call, []);
    expect("helper" in handover && handover.helper.model).toBe("deepseek-flash");
  });

  it("moves a helper off DeepSeek when the turn saw private content the thread hasn't stored yet", async () => {
    const handover = await startHelper(run, call, ["attachment"]);
    expect("helper" in handover && handover.helper.model).toBe("claude-haiku-5-5");
  });

  it("hands the helper its whole agent, read when it starts", async () => {
    const handover = await startHelper(run, call, []);
    expect(agents.byId).toHaveBeenCalledWith("r1", "a1");
    expect("helper" in handover && handover.helper.agent).toMatchObject({ name: "researcher", instructions: "Find sources.\nCite them." });
  });

  it("refuses an agent deleted since the run started, as one the room doesn't have", async () => {
    agents.byId.mockResolvedValue({ ...researcher, deleted: true });
    expect(await startHelper(run, call, [])).toEqual({ result: { steps: 2, costMicros: 0 } });
  });
});
