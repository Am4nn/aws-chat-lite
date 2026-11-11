"use client";

import { Children, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { findMentions, type Mentionable } from "../../lib/client/mentions";

const ALLOWED = ["p", "strong", "em", "code", "pre", "a", "br", "del"];
const SAFE_URL = /^https?:/i;

function withMentions(children: ReactNode, members: Mentionable[]): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts: ReactNode[] = [];
    let at = 0;
    for (const { start, end } of findMentions(child, members)) {
      parts.push(child.slice(at, start), <span key={start} className="mention text-lime">{child.slice(start, end)}</span>);
      at = end;
    }
    parts.push(child.slice(at));
    return parts;
  });
}

const staticComponents: Components = {
  a: ({ href, children }) =>
    href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky underline">{children}</a> : <>{children}</>,
  code: ({ children, className }) => (
    <code className={`${className ?? ""} rounded bg-surface-3 px-1 font-mono text-[0.9em]`}>{children}</code>
  ),
  pre: ({ children }) => <pre className="overflow-x-auto rounded-md bg-surface-3 p-2">{children}</pre>,
};

export function MessageText({ text, members }: { text: string; members: Mentionable[] }) {
  // A new component type each render would make React remount every paragraph, so they're rebuilt only when the
  // members (whose names the mentions match) change.
  const components = useMemo<Components>(() => {
    const prose = (Tag: "p" | "strong" | "em" | "del") =>
      function Prose({ children }: { children?: ReactNode }) {
        return <Tag>{withMentions(children, members)}</Tag>;
      };
    return { ...staticComponents, p: prose("p"), strong: prose("strong"), em: prose("em"), del: prose("del") };
  }, [members]);
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
