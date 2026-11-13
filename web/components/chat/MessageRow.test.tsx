// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomAgentsContext } from "@/lib/client/agents";
import type { Agent, Message, ThreadSummary } from "@/lib/types";
import { MessageRow, type RowActions, type RowContext } from "./MessageRow";

const threads = vi.hoisted(() => new Map<string, ThreadSummary>());
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ byId: (id: string) => threads.get(id) }) }));

const noop = () => {};
const actions: RowActions = {
  react: noop, reply: noop, replyInThread: noop, edit: noop, remove: noop, jump: noop, refetch: noop, retry: noop, discard: noop,
};
const ctx: RowContext = { meId: "me", role: "member", members: [], timeZone: "UTC", readOnly: false };
const message: Message = {
  roomId: "r", chatId: "c", seq: 4, authorId: "ben", authorName: "ben", text: "@me ship it?", createdAt: "2026-11-12T04:53:00Z",
  attachments: [], reactions: {}, mentions: ["me"], everyone: false,
};
const html = (m: Message, joins: { joinsAbove?: boolean; joinsBelow?: boolean } = {}) => renderToStaticMarkup(
  <MessageRow
    rowKey="k" message={m} status={undefined} ctx={ctx} actions={actions} groupStart={!joins.joinsAbove} enter={false} editing={false} active={false} onActivate={noop}
    joinsAbove={!!joins.joinsAbove} joinsBelow={!!joins.joinsBelow}
  />,
);
/** The row's own class list: the first element's. */
const rowClass = (out: string) => out.match(/class="([^"]*)"/)![1]!;
/** A left border or an inset bar on the left edge; `border-line-…` colour names don't count. */
const LEFT_BAR = /inset_2px|\bborder-l(-\d|[\s"])/;

describe("MessageRow", () => {
  it("marks a message that mentions you with a tint and an @ by its time, never a bar down its left edge", () => {
    const out = html(message);
    expect(out).toContain("bg-amber-wash");
    expect(out).toMatch(/aria-label="Mentions you"[^>]*>@</);
    expect(out).not.toMatch(LEFT_BAR);
  });

  it("leaves a message that doesn't mention you unmarked", () => {
    const out = html({ ...message, mentions: [] });
    expect(out).not.toContain("bg-amber-wash");
    expect(out).not.toContain("Mentions you");
  });

  it("rounds a highlighted run of grouped mentions only at its top and bottom, so it reads as one block", () => {
    expect(rowClass(html(message))).toMatch(/(^| )rounded-\[10px\]( |$)/);
    expect(rowClass(html(message, { joinsBelow: true }))).toMatch(/(^| )rounded-t-\[10px\]( |$)/);
    expect(rowClass(html(message, { joinsAbove: true }))).toMatch(/(^| )rounded-b-\[10px\]( |$)/);
    const middle = rowClass(html(message, { joinsAbove: true, joinsBelow: true }));
    expect(middle).not.toMatch(/rounded-/);
  });

  it("never marks a deleted message as mentioning you", () => {
    const out = html({ ...message, deleted: "admin" });
    expect(out).toContain("Removed by an admin");
    expect(out).not.toContain("bg-amber-wash");
    expect(out).not.toContain("Mentions you");
  });

  it("shows a quote reply as an icon and muted text, without a left bar", () => {
    const out = html({ ...message, mentions: [], replyTo: { seq: 2, authorName: "ava", excerpt: "the new empty states" } });
    expect(out).toContain("the new empty states");
    expect(out).toContain("lucide-corner-up-left");
    expect(out).not.toMatch(LEFT_BAR);
  });
});

describe("MessageRow Reply", () => {
  afterEach(cleanup);

  function clickReply(m: Message) {
    const reply = vi.fn();
    const replyInThread = vi.fn();
    render(
      <MessageRow
        rowKey="k" message={m} status={undefined} ctx={ctx} actions={{ ...actions, reply, replyInThread }} groupStart joinsAbove={false} joinsBelow={false}
        enter={false} editing={false} active={false} onActivate={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    return { reply, replyInThread };
  }

  it("quotes a person's message", () => {
    const { reply, replyInThread } = clickReply(message);
    expect(reply).toHaveBeenCalledWith(message);
    expect(replyInThread).not.toHaveBeenCalled();
  });

  it("on a message that started a thread, tags the thread instead of quoting", () => {
    const { reply, replyInThread } = clickReply({ ...message, threadRef: { threadId: "t1", kind: "started" } });
    expect(replyInThread).toHaveBeenCalledWith("t1");
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("MessageRow lead", () => {
  const agent = (agentId: string, name: string) => ({ agentId, name }) as Agent;
  const agents = [agent("a1", "scout"), agent("a2", "critic")];
  const started = (agentId: string) => {
    threads.set("t1", { threadId: "t1", number: 1, name: "review", agentId, status: "running" } as ThreadSummary);
    return renderToStaticMarkup(
      <RoomAgentsContext value={agents}>
        <MessageRow
          rowKey="k" message={{ ...message, text: "@critic @scout review", threadRef: { kind: "started", threadId: "t1" } }} status={undefined} ctx={ctx}
          actions={actions} groupStart enter={false} editing={false} active={false} onActivate={noop} joinsAbove={false} joinsBelow={false}
        />
      </RoomAgentsContext>,
    );
  };
  afterEach(() => threads.clear());

  it("marks the agent the thread went to as lead, not the first one the text names", () => {
    const out = started("a1");
    expect(out).toContain('title="Leads the thread">@scout</span>');
    expect(out).toContain('<span class="mention text-lime">@critic</span>');
  });
  it("marks no lead when the thread's agent is gone", () => expect(started("gone")).not.toContain("Leads the thread"));
});
