import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/types";
import { MessageRow, type RowActions, type RowContext } from "./MessageRow";

const noop = () => {};
const actions: RowActions = {
  react: noop, reply: noop, replyInThread: noop, edit: noop, remove: noop, jump: noop, refetch: noop, retry: noop, discard: noop,
};
const ctx: RowContext = { meId: "me", role: "member", members: [], timeZone: "UTC", readOnly: false };
const message: Message = {
  roomId: "r", chatId: "c", seq: 4, authorId: "ben", authorName: "ben", text: "@me ship it?", createdAt: "2026-11-12T04:53:00Z",
  attachments: [], reactions: {}, mentions: ["me"], everyone: false,
};
const html = (m: Message) => renderToStaticMarkup(
  <MessageRow rowKey="k" message={m} status={undefined} ctx={ctx} actions={actions} groupStart enter={false} editing={false} active={false} onActivate={noop} />,
);
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

  it("shows a quote reply as an icon and muted text, without a left bar", () => {
    const out = html({ ...message, mentions: [], replyTo: { seq: 2, authorName: "ava", excerpt: "the new empty states" } });
    expect(out).toContain("the new empty states");
    expect(out).toContain("lucide-corner-up-left");
    expect(out).not.toMatch(LEFT_BAR);
  });
});
