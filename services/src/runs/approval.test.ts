import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../threads/types.js";
import { gateOf, requestApproval } from "./approval.js";
import type { RoutedRun } from "./steps.js";

const fake = vi.hoisted(() => ({
  events: [] as RunEvent[], pushed: [] as unknown[], taint: [] as string[], archived: false, cancelled: [] as unknown[][], woken: [] as string[],
  room: {} as Record<string, unknown>,
}));

vi.mock("../approvals/repo.js", () => ({
  approvalsRepo: () => ({
    open: async (a: Record<string, unknown>) => ({ ...a, status: "pending" }),
    cancel: async (...args: unknown[]) => (fake.cancelled.push(args), "cb"),
  }),
}));
vi.mock("./repo.js", () => ({
  runsRepo: () => ({
    allEvents: async () => fake.events,
    eventWriter: async () => ({
      append: async (body: object) => {
        const event = { ...body, seq: fake.events.length + 1, at: "now" } as RunEvent;
        fake.events.push(event);
        return event;
      },
    }),
    markWaiting: async () => ({ thread: null }),
  }),
}));
vi.mock("./notify.js", () => ({ notifyRun: async () => {} }));
vi.mock("../threads/repo.js", () => ({ threadsRepo: () => ({ threadById: async () => ({ taint: fake.taint }) }) }));
vi.mock("./steps.js", async (actual) => ({
  ...await actual<object>(), limitsReached: async () => null, models: () => ({ servedBy: () => "fake" }),
  roomConnections: async (roomId: string) => ({
    roomId, github: null, mcp: [], approvalTimeoutSec: 600, approvalMode: "ask", postCap: 10, sandboxInternet: false, ...fake.room,
  }),
}));
vi.mock("../push/enqueue.js", () => ({ enqueuePush: async (job: unknown) => void fake.pushed.push(job) }));
vi.mock("../approvals/decide.js", () => ({ wakeRun: async (callbackId: string) => void fake.woken.push(callbackId) }));
vi.mock("../rooms/repo.js", () => ({
  roomDirectory: async () => ({ chats: [{ chatId: "C1", name: "general", lastSeq: 1, archived: false }], threads: [], agents: [] }),
}));
vi.mock("../agents/repo.js", async () => {
  const { BUILT_IN } = await import("../agents/model.js");
  const scout = { ...BUILT_IN, agentId: "S", name: "scout", builtIn: false, tools: ["room_agents", "web"], delegates: "all" };
  return { agentsRepo: () => ({ list: async () => [BUILT_IN, scout], byId: async () => scout }) };
});
vi.mock("../agents/kinds.js", () => ({ requireOffered: async () => {} }));
vi.mock("../budget/repo.js", () => ({ budgetRepo: () => ({ withArchived: async () => ({ archived: fake.archived }) }) }));

const run = { runId: "RUN", roomId: "R", threadId: "T", number: 7 } as RoutedRun;
const call = { id: "c1", name: "github_comment", input: { number: 1 } };
const gate = { timeoutSec: 600, title: "Comment on #1 in fake-org/playground?", input: { number: 1, repo: "fake-org/playground" } };

beforeEach(() => {
  fake.events = [];
  fake.pushed = [];
  fake.taint = [];
  fake.archived = false;
  fake.cancelled = [];
  fake.woken = [];
  fake.room = {};
});

describe("gateOf", () => {
  const drawing = { ...run, model: "claude-sonnet-5-5", agent: { tools: ["images"] } } as RoutedRun;
  const image = { id: "c2", name: "image_generate", input: { prompt: "the launch plan" } };

  it("lets an image go without asking in a clean thread", async () => {
    expect(await gateOf(drawing, image, [])).toEqual({ asks: false });
  });

  it("asks before an image in a private thread, as it would before a web call", async () => {
    fake.taint = ["attachment"];
    expect(await gateOf(drawing, image, [])).toEqual({
      asks: true, timeoutSec: 600, title: 'Send "the launch plan" to Gemini for an image?', input: image.input,
    });
    fake.taint = [];
    expect(await gateOf(drawing, image, ["sandbox"])).toMatchObject({ asks: true });
  });

  it("asks a helper lane's web call in Bypass once the thread read room chat", async () => {
    const helper = { ...run, model: "claude-sonnet-5-5", agent: { tools: ["web"] }, helper: { lane: 1, step: 2, task: "t", parent: "agent" } } as RoutedRun;
    const fetchCall = { id: "c3", name: "web_fetch", input: { url: "https://example.com/" } };
    fake.room = { approvalMode: "bypass" };
    expect(await gateOf(helper, fetchCall, [])).toEqual({ asks: false });
    fake.taint = ["room"];
    expect(await gateOf(helper, fetchCall, [])).toMatchObject({ asks: true, title: "Fetch https://example.com/?" });
  });

  it("asks before sandbox code while the sandbox reaches the internet in a thread that read room chat", async () => {
    const coding = { ...run, model: "claude-sonnet-5-5", agent: { tools: ["sandbox"] } } as RoutedRun;
    const code = { id: "c4", name: "sandbox_run", input: { language: "python", code: "print(1)" } };
    fake.taint = ["room"];
    expect(await gateOf(coding, code, [])).toEqual({ asks: false });
    fake.room = { sandboxInternet: true };
    expect(await gateOf(coding, code, [])).toEqual({
      asks: true, timeoutSec: 600, title: "Run python in the sandbox with internet access?", input: code.input,
    });
  });

  it("asks before a post from a private thread in Bypass, its whole text on the card", async () => {
    const posting = { ...run, model: "claude-sonnet-5-5", agent: { tools: ["room_post"] } } as RoutedRun;
    const text = `Release notes: ${"x".repeat(200)}`;
    const post = { id: "c6", name: "room_post", input: { chat: "general", text } };
    fake.room = { approvalMode: "bypass" };
    fake.taint = ["room"];
    expect(await gateOf(posting, post, [])).toEqual({ asks: false });
    fake.taint = ["github"];
    expect(await gateOf(posting, post, [])).toEqual({
      asks: true, timeoutSec: 600, title: `Post in #general: "${text.slice(0, 80)}"?`, input: { chat: "general", text },
    });
  });

  it("shows on an agent's setup card what the call will make, delegates and model spelled out", async () => {
    const making = { ...run, model: "claude-sonnet-5-5", agent: { agentId: "S", name: "scout", tools: ["room_agents"] } } as RoutedRun;
    const create = { id: "c7", name: "agent_create", input: { name: "helper", tools: ["web"] } };
    expect(await gateOf(making, create, [])).toEqual({
      asks: true, timeoutSec: 600, title: "Create @helper (web)?",
      input: { name: "helper", instructions: "", tools: ["web"], model: "room", delegates: "all" },
    });
  });

  it("names a GitHub read that has no approval title of its own by its tool", async () => {
    const reading = { ...run, model: "claude-sonnet-5-5", agent: { tools: ["github"] } } as RoutedRun;
    fake.room = { github: { installationId: 1, account: "fake-org", repos: ["fake-org/playground"], addedBy: "aman", addedAt: "now" } };
    fake.taint = ["room"];
    expect(await gateOf(reading, { id: "c5", name: "github_get", input: { number: 1 } }, [])).toMatchObject({
      asks: true, title: "Run github_get?", input: { number: 1, repo: "fake-org/playground" },
    });
  });
});

describe("requestApproval", () => {
  it("tells the room once, the first time the approval is logged", async () => {
    await requestApproval(run, call, 3, gate, "cb");
    await requestApproval(run, call, 3, gate, "cb");
    expect(fake.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(fake.pushed).toEqual([{ kind: "approval", roomId: "R", threadId: "T", number: 7, runId: "RUN", step: 3, title: gate.title }]);
    expect(fake.woken).toEqual([]);
  });

  it("wakes itself when the room was archived before it showed as waiting, which an archive's sweep would miss", async () => {
    fake.archived = true;
    await requestApproval(run, call, 3, gate, "cb");
    expect(fake.cancelled).toEqual([["RUN", 3, undefined]]);
    expect(fake.woken).toEqual(["cb"]);
  });
});
