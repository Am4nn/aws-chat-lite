"use client";

import { Children, useContext, useMemo, type ReactNode } from "react";
import Link from "next/link";
import Markdown, { type Components } from "react-markdown";
import { findAgentMentions, findMentions, type Mentionable } from "@/lib/client/mentions";
import { findTags, RoomTagsContext, type RoomTags } from "@/lib/client/roomTags";

const LEAD = "mention-lead rounded-full bg-lime/15 px-1.5 py-px font-medium text-lime";
const ALLOWED = ["p", "strong", "em", "code", "pre", "a", "br", "del"];
const NO_AGENTS: string[] = [];
const SAFE_URL = /^https?:/i;

type Names = { members: Mentionable[]; agents: string[]; lead?: string };

/** Mentions and `#tags` in the plain text between markdown's elements; code and links never get here. */
function decorate(children: ReactNode, names: Names, tags: RoomTags | null): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const mention = (m: { start: number; end: number }, lead: boolean) => lead
      ? <span key={m.start} className={LEAD} title="Leads the thread">{child.slice(m.start, m.end)}</span>
      : <span key={m.start} className="mention text-lime">{child.slice(m.start, m.end)}</span>;
    const found = [
      ...findMentions(child, names.members).map((m) => ({ ...m, node: mention(m, false) })),
      ...findAgentMentions(child, names.agents).map((m) => ({ ...m, node: mention(m, m.name === names.lead) })),
      ...(tags ? findTags(child, tags) : []).map((t) => ({ ...t, node: <TagLink key={t.start} {...t} /> })),
    ].sort((a, b) => a.start - b.start);
    const parts: ReactNode[] = [];
    let at = 0;
    for (const { start, end, node } of found) {
      if (start < at) continue;
      parts.push(child.slice(at, start), node);
      at = end;
    }
    parts.push(child.slice(at));
    return parts;
  });
}

function TagLink({ href, label, kind }: { href: string; label: string; kind: "thread" | "chat" }) {
  return (
    <Link
      href={href}
      className={kind === "thread"
        ? "rounded-full bg-sky/10 px-1.5 py-px text-[0.92em] text-sky transition-colors hover:bg-sky/20"
        : "text-sky underline-offset-2 hover:underline"}
    >
      {label}
    </Link>
  );
}

const staticComponents: Components = {
  a: ({ href, children }) =>
    href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky underline">{children}</a> : <>{children}</>,
  code: ({ children, className }) => (
    <code className={`${className ?? ""} rounded bg-surface-3 px-1 font-mono text-[0.9em]`}>{children}</code>
  ),
  pre: ({ children }) => <pre className="overflow-x-auto rounded-md bg-surface-3 p-2">{children}</pre>,
};

/** `agents` are the room's agent names, highlighted like members; `lead` is the agent of the thread the message started. */
export function MessageText({ text, members, agents = NO_AGENTS, lead }: {
  text: string; members: Mentionable[]; agents?: string[]; lead?: string;
}) {
  // A new component type each render would make React remount every paragraph, so they're rebuilt only when the
  // names the mentions match, or the lead, change.
  const components = useMemo<Components>(() => {
    const prose = (Tag: "p" | "strong" | "em" | "del") =>
      function Prose({ children }: { children?: ReactNode }) {
        // Read here, not in MessageText, so a renamed thread re-renders the paragraphs without parsing the markdown again.
        const tags = useContext(RoomTagsContext);
        return <Tag>{decorate(children, { members, agents, lead }, tags)}</Tag>;
      };
    return { ...staticComponents, p: prose("p"), strong: prose("strong"), em: prose("em"), del: prose("del") };
  }, [members, agents, lead]);
  return (
    <Markdown
      allowedElements={ALLOWED}
      unwrapDisallowed
      skipHtml
      components={components}
      urlTransform={(url) => (SAFE_URL.test(url) ? url : "")}
    >
      {text}
    </Markdown>
  );
}
