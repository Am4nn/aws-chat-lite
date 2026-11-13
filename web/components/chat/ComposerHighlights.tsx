"use client";

import { useContext, useMemo, type ReactNode, type Ref } from "react";
import { useAgentNames } from "@/lib/client/agents";
import { findAgentMentions, findMentions, outsideCode, type Mentionable } from "@/lib/client/mentions";
import { findDraftTags, RoomTagsContext } from "@/lib/client/roomTags";

/**
 * The text box's text again, drawn behind the box (whose own text is transparent), with the mentions and tags that
 * will light up once sent in their colours. It has to lay out exactly as the box does, so `className` carries the
 * box's font, padding, wrapping and scrollbar gutter, and a mark changes colour only: any padding, border or weight
 * would move the text out from under the caret. The box sets its scroll position.
 */
export function ComposerHighlights({ ref, text, members, className }: {
  ref: Ref<HTMLDivElement>; text: string; members: Mentionable[]; className: string;
}) {
  const agents = useAgentNames();
  const tags = useContext(RoomTagsContext);
  const parts = useMemo(() => {
    const prose = outsideCode(text);
    const found = [
      ...findMentions(prose, members).map((m) => ({ ...m, tone: "text-lime" })),
      ...findAgentMentions(prose, agents).map((m) => ({ ...m, tone: "text-lime" })),
      ...(tags ? findDraftTags(prose, tags) : []).map((t) => ({ ...t, tone: "text-sky" })),
    ].sort((a, b) => a.start - b.start);
    const out: ReactNode[] = [];
    let at = 0;
    for (const { start, end, tone } of found) {
      if (start < at) continue;
      out.push(text.slice(at, start), <mark key={start} className={`bg-transparent ${tone}`}>{text.slice(start, end)}</mark>);
      at = end;
    }
    out.push(text.slice(at));
    return out;
  }, [text, members, agents, tags]);

  return (
    <div ref={ref} aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden text-text ${className}`}>
      {parts}
      {/* A box's last line can be empty after a newline; a div drops that line unless something is on it. */}
      {" "}
    </div>
  );
}
