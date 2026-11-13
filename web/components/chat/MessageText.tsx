"use client";

import { Children, useContext, useMemo, type ReactNode } from "react";
import Link from "next/link";
import Markdown, { type Components } from "react-markdown";
import { agentMentionables, findMentions, firstAgent, type Mentionable } from "@/lib/client/mentions";
import { findTags, RoomTagsContext, type RoomTags } from "@/lib/client/roomTags";

const LEAD = "mention-lead rounded-full bg-lime/15 px-1.5 py-px font-medium text-lime";
const ALLOWED = ["p", "strong", "em", "code", "pre", "a", "br", "del"];
const NO_AGENTS: string[] = [];
const SAFE_URL = /^https?:/i;

/** Mentions and `#tags` in the plain text between markdown's elements; code and links never get here. */
function decorate(children: ReactNode, members: Mentionable[], tags: RoomTags | null, lead?: string): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const found = [
      ...findMentions(child, members).map((m) => ({ ...m, node: m.name === lead
        ? <span key={m.start} className={LEAD} title="Leads the thread">{child.slice(m.start, m.end)}</span>
        : <span key={m.start} className="mention text-lime">{child.slice(m.start, m.end)}</span> })),
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

/**
 * `agents` are the room's agent names, highlighted like members. `lead` says the message started a thread: the first
 * agent it names, the one the thread went to, is marked as the one leading it.
 */
export function MessageText({ text, members, agents = NO_AGENTS, lead = false }: {
  text: string; members: Mentionable[]; agents?: string[]; lead?: boolean;
}) {
  const leader = lead ? firstAgent(text, agents) : undefined;
  // A new component type each render would make React remount every paragraph, so they're rebuilt only when the
  // names the mentions match, or the lead, change.
  const components = useMemo<Components>(() => {
    const prose = (Tag: "p" | "strong" | "em" | "del") =>
      function Prose({ children }: { children?: ReactNode }) {
        // Read here, not in MessageText, so a renamed thread re-renders the paragraphs without parsing the markdown again.
        const tags = useContext(RoomTagsContext);
        return <Tag>{decorate(children, mentionables, tags, leader)}</Tag>;
      };
    const mentionables = [...members, ...agentMentionables(agents)];
    return { ...staticComponents, p: prose("p"), strong: prose("strong"), em: prose("em"), del: prose("del") };
  }, [members, agents, leader]);
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
