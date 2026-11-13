"use client";

import { Children, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import Markdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { findAgentMentions, findMentions, type Mentionable } from "@/lib/client/mentions";
import { findTags, RoomTagsContext, type RoomTags } from "@/lib/client/roomTags";

const LEAD = "mention-lead rounded-full bg-lime/15 px-1.5 py-px font-medium text-lime";
const ALLOWED = ["p", "strong", "em", "code", "pre", "a", "br", "del"];
// An agent's answer can be a whole write-up; people's chat lines stay inline, so a "# " in chat never turns into a title.
const RICH_ALLOWED = [...ALLOWED, "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "hr", "table", "thead", "tbody", "tr", "th", "td"];
const RICH_PLUGINS = [remarkGfm, remarkBreaks];
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

const HEADING = "font-semibold leading-[1.4] text-text first:mt-0";
// The classes of the rich elements whose text can hold mentions; the rest have none to decorate.
const RICH_PROSE = {
  li: "pl-1 [li+&]:mt-1",
  h1: `mt-5 text-[19px] ${HEADING}`,
  h2: `mt-5 text-[17px] ${HEADING}`,
  h3: `mt-4 text-[15.5px] ${HEADING}`,
  h4: `mt-4 text-[15.5px] ${HEADING}`,
  blockquote: "space-y-2 border-l-2 border-line-strong pl-3 text-text-2",
  th: "border border-line-strong px-2.5 py-1.5 text-left font-semibold text-text",
  td: "border border-line-strong px-2.5 py-1.5 align-top",
};

const richComponents: Components = {
  ...staticComponents,
  ul: ({ children }) => <ul className="list-disc pl-5 marker:text-text-3 [li>&]:mt-1">{children}</ul>,
  ol: ({ start, children }) => <ol start={start} className="list-decimal pl-5 marker:text-text-3 [li>&]:mt-1">{children}</ol>,
  hr: () => <hr className="my-5 border-line-strong" />,
  table: ({ children }) => (
    <div className="overflow-x-auto"><table className="border-collapse text-[14px]">{children}</table></div>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg bg-surface-3 p-3 leading-[1.55] [&>code]:p-0 [&>code]:text-[13px]">{children}</pre>
  ),
};

type ProseTag = "p" | "strong" | "em" | "del" | keyof typeof RICH_PROSE;

/**
 * `agents` are the room's agent names, highlighted like members; `lead` is the agent of the thread the message started.
 * `rich` is for an agent's answer: lists, headings, quotes, tables and line breaks as written.
 */
export function MessageText({ text, members, agents = NO_AGENTS, lead, rich = false }: {
  text: string; members: Mentionable[]; agents?: string[]; lead?: string; rich?: boolean;
}) {
  // A new component type each render would make React remount every paragraph, so they're rebuilt only when the
  // names the mentions match, or the lead, change.
  const components = useMemo<Components>(() => {
    const prose = (Tag: ProseTag, className?: string) =>
      function Prose({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
        // Read here, not in MessageText, so a renamed thread re-renders the paragraphs without parsing the markdown again.
        const tags = useContext(RoomTagsContext);
        return <Tag className={className} style={style}>{decorate(children, { members, agents, lead }, tags)}</Tag>;
      };
    const inline = { p: prose("p"), strong: prose("strong"), em: prose("em"), del: prose("del") };
    if (!rich) return { ...staticComponents, ...inline };
    const blocks = Object.fromEntries(Object.entries(RICH_PROSE).map(([tag, className]) => [tag, prose(tag as ProseTag, className)]));
    return { ...richComponents, ...inline, ...blocks };
  }, [members, agents, lead, rich]);
  return (
    <Markdown
      allowedElements={rich ? RICH_ALLOWED : ALLOWED}
      remarkPlugins={rich ? RICH_PLUGINS : undefined}
      unwrapDisallowed
      skipHtml
      components={components}
      urlTransform={(url) => (SAFE_URL.test(url) ? url : "")}
    >
      {text}
    </Markdown>
  );
}
