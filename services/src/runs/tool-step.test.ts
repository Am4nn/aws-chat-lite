import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN } from "../agents/model.js";
import type { McpConnection, RunEvent } from "../threads/types.js";
import type { ToolEnv } from "../tools/types.js";
import type { RoutedRun } from "./steps.js";
import { toolStep } from "./tool-step.js";

const runs = {
  allEvents: vi.fn(async (): Promise<RunEvent[]> => []),
  eventWriter: vi.fn(async () => ({ append: async (e: object) => ({ ...e, seq: 7, at: "2026-11-12T00:00:00.000Z" }) })),
  progress: vi.fn(async () => ({})),
  stepDone: vi.fn(async () => ({})),
  recorded: vi.fn(async () => undefined),
  callMarker: vi.fn(() => ({})),
  getRun: vi.fn(async () => ({ deadAt: "2026-11-12T02:00:00.000Z" })),
};
const audit = { record: vi.fn() };
const fake = vi.hoisted(() => ({
  mcp: [] as unknown[], addTaint: vi.fn(async () => {}), runSandbox: vi.fn(async () => ({ ok: true, output: "4", ms: 5 })),
  mode: "ask", internet: false, taint: [] as string[], send: vi.fn(),
  createByAgent: vi.fn(async (_roomId: string, input: { name: string }) => input),
}));
vi.mock("./repo.js", () => ({ runsRepo: () => runs }));
vi.mock("./notify.js", () => ({ notifyRun: async () => {} }));
vi.mock("../audit/repo.js", () => ({ auditRepo: () => audit }));
vi.mock("../budget/repo.js", () => ({
  budgetRepo: () => ({
    withArchived: async () => ({ budget: { spentMicros: 0, capMicros: 3_000_000, month: "2026-11" }, archived: false }), spend: () => ({}),
  }),
}));
vi.mock("../connections/repo.js", () => ({
  connectionsRepo: () => ({
    get: async () => ({ github: null, mcp: fake.mcp, approvalTimeoutSec: 7200, approvalMode: fake.mode, postCap: 10, sandboxInternet: fake.internet }),
  }),
}));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => ({ addTaint: fake.addTaint, threadById: async () => ({ taint: fake.taint }) }) }));
vi.mock("../images/step.js", async (actual) => ({
  ...await actual<object>(), imageDeps: () => ({}), generateImageStep: async () => ({ ok: true, output: "Saved images/1-1-1-cat.png." }),
}));
vi.mock("../workspace/session.js", () => ({ runSandbox: fake.runSandbox }));
vi.mock("../rooms/repo.js", () => ({
  roomDirectory: async () => ({
    chats: [{ chatId: "c1", name: "general", lastSeq: 1, archived: false }], threads: [], agents: [BUILT_IN],
    members: [{ userId: "u1", username: "aman", role: "owner" }],
  }),
}));
vi.mock("../chat/repo.js", () => ({ chatRepo: () => ({ send: fake.send }) }));
vi.mock("../agents/repo.js", () => ({ agentsRepo: () => ({ list: async () => [BUILT_IN], createByAgent: fake.createByAgent }) }));

process.env.MODEL_GATEWAY = "fake";

const run = {
  runId: "run1", roomId: "r1", threadId: "t1", number: 3, agentId: "agent", status: "running", pick: "sonnet", pickBy: "pick",
  model: "claude-sonnet-5-5", startedBy: "aman", startedById: "u-aman", startedAt: new Date().toISOString(), deadAt: "2026-11-12T02:00:00.000Z",
  firstSeq: 1, seenSeq: 1, steps: 0, costMicros: 0, agent: { ...BUILT_IN, tools: ["images", "sandbox"] }, others: [],
} satisfies RoutedRun;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fake, { mcp: [], mode: "ask", internet: false, taint: [] });
});

const NOW_ASKS = "This call now needs a room member's approval. Call it again to ask for it.";

/** A member's no to `call`, as the settled approval comes back. */
const deniedBy = (by: string, call: { id: string; name: string; input: Record<string, unknown> }) => ({
  runId: "run1", roomId: "r1", threadId: "t1", step: 1, call, title: "t", callbackId: "cb",
  expiresAt: "2026-11-12T00:10:00.000Z", requestedAt: "2026-11-12T00:00:00.000Z", status: "denied" as const, by,
});

/** The step's events, as the writer is handed them. */
const logged = () => {
  const appended: RunEvent[] = [];
  runs.eventWriter.mockResolvedValue({ append: async (e: object) => (appended.push(e as RunEvent), { ...e, seq: 7, at: "2026-11-12T00:00:00.000Z" }) });
  return appended;
};

describe("toolStep", () => {
  it.each([
    ["image_generate", { prompt: "a cat on a mat" }, 'Drawing "a cat on a mat"'],
    ["sandbox_run", { language: "python", code: "print(2 + 2)" }, "Running python: print(2 + 2)"],
  ])("logs %s in the room's audit, once per step, keyed by the step's start", async (name, input, detail) => {
    await toolStep(run, { id: "c1", name, input });
    expect(audit.record).toHaveBeenCalledWith("r1", {
      id: "run1#7", at: "2026-11-12T00:00:00.000Z", actor: "agent", kind: "tool", threadNumber: 3, tool: name, detail, agent: "agent",
    });
  });

  it("an image a member didn't approve is neither made nor logged as run", async () => {
    const settled = deniedBy("bea", { id: "c1", name: "image_generate", input: { prompt: "the plan" } });
    const appended = logged();
    await toolStep(run, settled.call, settled);
    expect(audit.record).not.toHaveBeenCalled();
    expect(appended.find((e) => e.type === "step.finished")).toMatchObject({ ok: false, output: expect.stringMatching(/^Denied by bea\./) });
  });

  it("doesn't run sandbox code a member denied, and leaves the thread's taint alone", async () => {
    const settled = deniedBy("bea", { id: "c1", name: "sandbox_run", input: { language: "python", code: "print(1)" } });
    const appended = logged();
    await toolStep(run, settled.call, settled);
    expect(fake.runSandbox).not.toHaveBeenCalled();
    expect(fake.addTaint).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(appended.find((e) => e.type === "step.finished")).toMatchObject({ ok: false, output: expect.stringMatching(/^Denied by bea\./) });
    expect(appended.some((e) => e.type === "usage")).toBe(false);
  });

  it("a write the room's mode lets run goes ahead with no approval", async () => {
    const conn: McpConnection = {
      name: "test", url: "http://127.0.0.1:4710/mcp", auth: "oauth", status: "connected", toolCount: 1, toolsAt: "2026-11-11T00:00:00Z",
      addedBy: "aman", addedAt: "2026-11-11T00:00:00Z", tools: [{ name: "add_note", description: "Saves a note.", inputSchema: { type: "object" }, readOnly: false, destructive: false }],
    };
    fake.mcp = [conn];
    fake.mode = "bypass";
    const mcpCall = vi.fn(async () => ({ ok: true, output: "saved" }));
    const appended = logged();
    const writer = { ...run, agent: { ...BUILT_IN, tools: ["mcp" as const] } };
    await toolStep(writer, { id: "c1", name: "mcp__test__add_note", input: { text: "hi" } }, undefined, async () => ({ mcpCall }) as unknown as ToolEnv);
    expect(mcpCall).toHaveBeenCalledWith({ roomId: "r1", name: "test" }, "add_note", { text: "hi" });
    expect(appended.find((e) => e.type === "step.finished")).toMatchObject({ ok: true, output: "saved" });
  });

  it("holds back a call its gate let through once it would ask: here the thread read room chat in the meantime", async () => {
    const fetchPage = vi.fn(async () => ({ url: "https://example.com/", status: 200, contentType: "text/plain", body: "hi" }));
    const envOf = async () => ({ fetchPage, keys: {} }) as unknown as ToolEnv;
    const reader = { ...run, agent: { ...BUILT_IN, tools: ["web" as const] } };
    const call = { id: "c1", name: "web_fetch", input: { url: "https://example.com/" } };
    fake.mode = "auto";
    fake.taint = ["room"];
    const appended = logged();
    await toolStep(reader, call, undefined, envOf);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(appended.find((e) => e.type === "step.finished")).toMatchObject({ ok: false, output: NOW_ASKS });

    const approved = { ...deniedBy("bea", call), status: "approved" as const };
    await toolStep(reader, call, approved, envOf);
    expect(fetchPage).toHaveBeenCalledWith("https://example.com/");
  });

  it("holds back sandbox code once the sandbox reaches the internet in a thread that read room chat", async () => {
    fake.internet = true;
    fake.taint = ["room"];
    const appended = logged();
    await toolStep(run, { id: "c1", name: "sandbox_run", input: { language: "python", code: "print(1)" } });
    expect(fake.runSandbox).not.toHaveBeenCalled();
    expect(fake.addTaint).not.toHaveBeenCalled();
    expect(appended.find((e) => e.type === "step.finished")).toMatchObject({ ok: false, output: NOW_ASKS });
    expect(appended.some((e) => e.type === "usage")).toBe(false);
  });

  it("marks the thread as holding room data before a read's result is logged", async () => {
    const order: unknown[] = [];
    fake.addTaint.mockImplementation(async (...args: unknown[]) => void order.push(args));
    runs.eventWriter.mockResolvedValue({ append: async (e: object) => (order.push(e), { ...e, seq: 7, at: "2026-11-12T00:00:00.000Z" }) });
    const reader = { ...run, agent: { ...BUILT_IN, tools: ["room_read" as const] } };
    await toolStep(reader, { id: "c1", name: "room_members", input: {} });
    expect(order).toEqual([
      expect.objectContaining({ type: "step.started" }),
      ["r1", 3, ["room"]],
      expect.objectContaining({ type: "step.finished", ok: true, output: "aman · owner" }),
    ]);
  });

  it("never posts twice: a post step found already started tells the model to check the chat", async () => {
    const call = { id: "c1", name: "room_post", input: { chat: "general", text: "Deploy done" } };
    runs.allEvents.mockResolvedValueOnce([{ type: "step.started", step: 1, call, detail: "#general", seq: 5, at: "2026-11-12T00:00:00.000Z" }]);
    fake.mode = "auto";
    const appended = logged();
    await toolStep({ ...run, agent: { ...BUILT_IN, tools: ["room_post"] } }, call);
    expect(fake.send).not.toHaveBeenCalled();
    expect(appended.find((e) => e.type === "step.finished")).toMatchObject({
      ok: false, output: "This write may or may not have happened (the step was interrupted). Check the chat before trying again.",
    });
  });

  describe("an agent call", () => {
    const maker = { ...run, agent: { ...BUILT_IN, tools: ["room_agents" as const] } };
    const call = { id: "c1", name: "agent_create", input: { name: "helper", tools: [] } };

    it("carries its approver when approved, and none when the room's mode ran it without asking", async () => {
      const approved = { ...deniedBy("bea", call), status: "approved" as const, byId: "u-bea" };
      await toolStep(maker, call, approved);
      expect(fake.createByAgent).toHaveBeenLastCalledWith("r1", expect.objectContaining({ name: "helper" }), { agentId: "agent", name: "agent" }, {
        userId: "u-bea", username: "bea",
      });
      fake.mode = "auto";
      await toolStep(maker, call);
      expect(fake.createByAgent).toHaveBeenLastCalledWith("r1", expect.anything(), expect.anything(), undefined);
    });

    it("is never made twice: a step found already started tells the model to check the room's agents", async () => {
      runs.allEvents.mockResolvedValueOnce([{ type: "step.started", step: 1, call, detail: "@helper", seq: 5, at: "2026-11-12T00:00:00.000Z" }]);
      fake.mode = "auto";
      const appended = logged();
      await toolStep(maker, call);
      expect(fake.createByAgent).not.toHaveBeenCalled();
      expect(appended.find((e) => e.type === "step.finished")).toMatchObject({
        ok: false, output: "This write may or may not have happened (the step was interrupted). Check the room's agents before trying again.",
      });
    });
  });

  it("logs nothing for a tool the model was never offered", async () => {
    await toolStep(run, { id: "c1", name: "github_comment", input: {} });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
