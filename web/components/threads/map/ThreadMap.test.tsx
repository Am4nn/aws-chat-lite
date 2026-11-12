// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyRun } from "@/lib/client/run";
import type { Message, ThreadSummary } from "@/lib/types";
import { ThreadMap } from "./RunMap";

vi.mock("@/lib/client/useRunStream", () => ({ useRunStream: () => ({ run: emptyRun(), unavailable: false }) }));
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ byId: () => undefined }) }));

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

const thread = { threadId: "t1", number: 1, status: "idle", runId: "r12" } as unknown as ThreadSummary;
/** A thread of `n` turns, each a prompt and the answer that names its run. */
const turns = (n: number) => Array.from({ length: n }, (_, i) => [
  { seq: 2 * i + 1, text: `prompt ${i + 1}`, authorId: "u1" },
  { seq: 2 * i + 2, text: "answer", authorId: "agent", agent: { runId: `r${i + 1}`, firstSeq: 2 * i + 1 } },
]).flat() as unknown as Message[];

describe("ThreadMap", () => {
  it("shows every turn of the thread at once, each headed by the message that started it", () => {
    render(<ThreadMap thread={{ ...thread, runId: "r3" }} messages={turns(3)} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["prompt 1", "prompt 2", "prompt 3"]);
  });

  it("loads the latest 10 turns and offers the earlier ones", () => {
    render(<ThreadMap thread={thread} messages={turns(12)} />);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Show 2 earlier turns" }));
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /earlier turns/ })).toBeNull();
  });

  it("scrolls to the turn a message's Map link names", () => {
    render(<ThreadMap thread={{ ...thread, runId: "r3" }} runId="r2" messages={turns(3)} />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.getElementById("run-r2")).not.toBeNull();
  });
});
