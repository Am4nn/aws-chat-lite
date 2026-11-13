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
const html = (m: Message, group: { groupStart?: boolean; groupEnd?: boolean } = {}) => renderToStaticMarkup(
  <MessageRow
    rowKey="k" message={m} status={undefined} ctx={ctx} actions={actions} enter={false} editing={false} active={false} onActivate={noop}
    groupStart={group.groupStart ?? true} groupEnd={group.groupEnd ?? true}
  />,
);
/** The bubble around a message's text: the paragraph sits in the body, which sits in the bubble. */
function bubble(m: Message, group: { groupStart?: boolean; groupEnd?: boolean } = {}) {
  const row = document.createElement("div");
  row.innerHTML = html(m, group);
  return row.querySelector("p")!.parentElement!.parentElement!.className;
}
/** A left border or an inset bar on the left edge; `border-line-…` colour names don't count. */
const LEFT_BAR = /inset_2px|\bborder-l(-\d|[\s"])/;
const mine: Message = { ...message, authorId: "me", authorName: "aman", text: "on it", mentions: [] };
const theirs: Message = { ...message, mentions: [] };

describe("MessageRow", () => {
  it("names my messages for a screen reader, and keeps the toolbar off my bubble, over the row's empty left", () => {
    const out = html(mine);
    expect(out).toContain('<span class="sr-only">You</span>');
    expect(out).toMatch(/role="toolbar"[^>]*class="[^"]*-top-4 left-3/);
    expect(html(message)).toMatch(/role="toolbar"[^>]*class="[^"]*-top-4 right-3/);
  });

  it("shows a schedule's message as the room's automation, with the agent's tile and AI tag, never a person's avatar", () => {
    const out = html({ ...message, authorId: "schedule", authorName: "schedule", mentions: [] });
    expect(out).toContain("bg-lime-wash text-lime");
    expect(out).toContain(">AI</span>");
    expect(out).not.toContain("rounded-full font-bold uppercase");
  });

  describe("an agent's post", () => {
    const post: Message = { ...message, authorId: "agent", authorName: "scout", text: "Deploy done", mentions: [], agentPost: { threadId: "T4", number: 4 } };
    afterEach(() => threads.clear());

    it("shows the agent's tile, its own name in lime and the AI tag, never a person's avatar, and links to its thread by current name", () => {
      threads.set("T4", { threadId: "T4", number: 4, name: "release" } as ThreadSummary);
      const out = html(post);
      expect(out).toContain("bg-lime-wash text-lime");
      expect(out).toContain(">scout</span>");
      expect(out).toContain(">AI</span>");
      expect(out).not.toContain("rounded-full font-bold uppercase");
      const row = document.createElement("div");
      row.innerHTML = out;
      const link = row.querySelector("a")!;
      expect(link.textContent).toBe("from #release");
      expect(link.getAttribute("href")).toBe("/r/r/t/4");
    });

    it("links by number when the thread isn't loaded", () => {
      const row = document.createElement("div");
      row.innerHTML = html(post);
      expect(row.querySelector("a")!.textContent).toBe("from #4");
    });
  });

  it("outlines a bubble that mentions me, so it stands out from the plain ones", () =>
    expect(html(message)).toContain("bg-amber-wash ring-1 ring-inset ring-amber-line"));

  it("puts my message on the right as a plain bubble, with no avatar or name, and its time under the group", () => {
    const out = html(mine);
    expect(out).toContain("items-end");
    expect(out).not.toContain("aman");
    expect(out).not.toContain("rounded-full");
    expect(out).toMatch(/<time[^>]*>4:53 AM<\/time>/);
    expect(bubble(mine)).toContain("bg-surface-3");
  });

  it("gives the time under my group only to its last message", () => {
    expect(html(mine, { groupEnd: false })).not.toMatch(/<time[^>]*>4:53 AM</);
  });

  it("puts someone else's message on the left, with their avatar and name at the start of the group only", () => {
    const out = html(theirs);
    expect(out).toContain("rounded-full");
    expect(out).toContain(">ben</span>");
    expect(bubble(theirs)).toContain("bg-surface-2");
    const later = html(theirs, { groupStart: false });
    expect(later).not.toContain(">ben</span>");
    expect(later).not.toContain("rounded-full");
  });

  it("points a bubble's corner at its sender, flatter on the messages that follow in a group", () => {
    expect(bubble(mine)).toContain("rounded-[16px_16px_6px_16px]");
    expect(bubble(mine, { groupStart: false })).toContain("rounded-[16px_6px_6px_16px]");
    expect(bubble(theirs)).toContain("rounded-[16px_16px_16px_6px]");
    expect(bubble(theirs, { groupStart: false })).toContain("rounded-[6px_16px_16px_6px]");
  });

  it("marks a message that mentions you with an amber bubble and an @ by its time, never a bar down its left edge", () => {
    const out = html(message);
    expect(bubble(message)).toContain("bg-amber-wash");
    expect(out).toMatch(/aria-label="Mentions you"[^>]*>@</);
    expect(out).not.toMatch(LEFT_BAR);
  });

  it("leaves a message that doesn't mention you unmarked", () => {
    const out = html(theirs);
    expect(out).not.toContain("bg-amber-wash");
    expect(out).not.toContain("Mentions you");
  });

  it("never marks a deleted message as mentioning you", () => {
    const out = html({ ...message, deleted: "admin" });
    expect(out).toContain("Removed by an admin");
    expect(out).not.toContain("bg-amber-wash");
    expect(out).not.toContain("Mentions you");
  });

  it("shows a quote reply as an icon and muted text, without a left bar", () => {
    const out = html({ ...theirs, replyTo: { seq: 2, authorName: "ava", excerpt: "the new empty states" } });
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
        rowKey="k" message={m} status={undefined} ctx={ctx} actions={{ ...actions, reply, replyInThread }} groupStart groupEnd
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
          actions={actions} groupStart enter={false} editing={false} active={false} onActivate={noop} groupEnd
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
