// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@/lib/types";
import { ThreadRef } from "./ThreadCard";

const thread = (n: number, name: string) => ({ threadId: `t${n}`, number: n, name, status: "done", agentId: "agent" }) as ThreadSummary;
const known = new Map([thread(1, "pr-check"), thread(2, "docs")].map((t) => [t.threadId, t]));
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ byId: (id: string) => known.get(id) }) }));

afterEach(cleanup);

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

  it("shows a started thread as its card", () => {
    render(<ThreadRef threadRef={{ kind: "started", threadId: "t1" }} roomId="r1" readOnly onReply={() => {}} />);
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/r/r1/t/1");
  });
});
