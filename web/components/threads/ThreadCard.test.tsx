// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@/lib/types";
import { ThreadRef } from "./ThreadCard";

const thread = vi.hoisted(() => ({ current: undefined as ThreadSummary | undefined }));
const named = (n: number, name: string) => ({ threadId: `t${n}`, number: n, name, status: "done", agentId: "agent" }) as ThreadSummary;
const known = new Map([named(1, "pr-check"), named(2, "docs")].map((t) => [t.threadId, t]));
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ byId: (id: string) => thread.current ?? known.get(id) }) }));

afterEach(() => {
  cleanup();
  thread.current = undefined;
});

const links = () => screen.queryAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);

describe("ThreadRef", () => {
  it("shows one chip for each thread a message was delivered into, in order", () => {
    render(<ThreadRef threadRef={{ kind: "delivered", threads: [{ threadId: "t2" }, { threadId: "t1" }] }} roomId="r1" readOnly={false} onReply={() => {}} />);
    expect(links()).toEqual([["→ #docs", "/r/r1/t/2"], ["→ #pr-check", "/r/r1/t/1"]]);
  });

  it("leaves out a thread the room doesn't know (yet)", () => {
    render(<ThreadRef threadRef={{ kind: "delivered", threads: [{ threadId: "t9" }, { threadId: "t1" }] }} roomId="r1" readOnly={false} onReply={() => {}} />);
    expect(links()).toEqual([["→ #pr-check", "/r/r1/t/1"]]);
  });
});

const base: ThreadSummary = {
  roomId: "r", threadId: "t1", number: 7, name: "pr-review", agentId: "agent", status: "done", rev: 1, steps: 3, costMicros: 0,
  startedAt: "2026-11-12T10:00:00Z", endedAt: "2026-11-12T10:00:42Z", summary: "The answer, which goes stale as the thread goes on",
  createdBy: "u", lastActivityAt: "2026-11-12T10:00:42Z", archived: false, taint: [],
};

function card(t: Partial<ThreadSummary> = {}, onReply = vi.fn()) {
  thread.current = { ...base, ...t };
  render(<ThreadRef threadRef={{ threadId: "t1", kind: "started" }} roomId="r" readOnly={false} onReply={onReply} />);
  return { onReply, text: document.body.textContent ?? "" };
}

describe("ThreadCard", () => {
  it("shows the thread's tag, agent, status and totals, never the answer", () => {
    const { text } = card();
    expect(text).toContain("#pr-review");
    expect(text).toContain("@agent");
    expect(text).toContain("Done");
    expect(text).toContain("3 steps · 0:42");
    expect(text).not.toContain("The answer");
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/r/r/t/7");
  });

  it("marks the agent as one: a robot avatar, its name in lime and an AI tag, beside the status icon", () => {
    card();
    const name = screen.getByText("@agent");
    expect(name.className).toContain("text-lime");
    expect(name.nextElementSibling?.textContent).toBe("AI");
    expect(document.querySelector(".lucide-bot")).not.toBeNull();
    expect(document.querySelector("svg.text-sky")).not.toBeNull();
  });

  it("counts the steps while it runs", () => {
    const { text } = card({ status: "running", steps: 2, endedAt: undefined, currentStep: "search_notes" });
    expect(text).toContain("Running");
    expect(text).toMatch(/step 2 · \d+:\d\d/);
  });

  it("says how a run ended that didn't finish", () => {
    expect(card({ status: "failed" }).text).toContain("Failed");
    cleanup();
    expect(card({ status: "stopped" }).text).toContain("Stopped");
  });

  it("offers Reply, which hands back the thread to tag", () => {
    const { onReply } = card();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledWith("t1");
  });
});
