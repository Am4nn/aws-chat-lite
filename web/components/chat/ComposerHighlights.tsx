"use client";

import { useContext, type ReactNode, type Ref } from "react";
import { useAgentNames } from "@/lib/client/agents";
import { findAgentMentions, findMentions, outsideCode, type Mentionable } from "@/lib/client/mentions";
import { findDraftTags, RoomTagsContext } from "@/lib/client/roomTags";

/**
 * The text box's text again, drawn behind the box (whose own text is transparent), with the mentions and tags that
 * will light up once sent in their colours. It has to lay out exactly as the box does, so `className` carries the
 * box's font, padding and wrapping, and a mark changes colour only: any padding, border or weight would move the text
 * out from under the caret. It scrolls too, so a scrollbar narrows both the same way.
 */
export function ComposerHighlights({ ref, text, members, className }: {
  ref: Ref<HTMLDivElement>; text: string; members: Mentionable[]; className: string;
}) {
  const agents = useAgentNames();
  const tags = useContext(RoomTagsContext);
  const prose = outsideCode(text);
  const found = [
    ...findMentions(prose, members).map((m) => ({ ...m, tone: "text-lime" })),
    ...findAgentMentions(prose, agents).map((m) => ({ ...m, tone: "text-lime" })),
    ...(tags ? findDraftTags(prose, tags) : []).map((t) => ({ ...t, tone: "text-sky" })),
  ].sort((a, b) => a.start - b.start);

  const parts: ReactNode[] = [];
  let at = 0;
  for (const { start, end, tone } of found) {
    if (start < at) continue;
    parts.push(text.slice(at, start), <mark key={start} className={`bg-transparent ${tone}`}>{text.slice(start, end)}</mark>);
    at = end;
  }
  return (
    <div ref={ref} aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-y-auto text-text ${className}`}>
      {parts}
      {text.slice(at)}
      {/* A box's last line can be empty after a newline; a div drops that line unless something is on it. */}
      {" "}
    </div>
  );
}
