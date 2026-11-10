"use client";

import { Children, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { findMentions, type Mentionable } from "../../lib/client/mentions";

const ALLOWED = ["p", "strong", "em", "code", "pre", "a", "br", "del"];
const SAFE_URL = /^(https?:|mailto:)/i;

function withMentions(children: ReactNode, members: Mentionable[], onTag?: (name: string) => void): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts: ReactNode[] = [];
    let at = 0;
    for (const { start, end } of findMentions(child, members)) {
      parts.push(child.slice(at, start));
      const label = child.slice(start, end);
      parts.push(
        <span key={start} className="mention text-lime" onClick={onTag && (() => onTag(label.slice(1)))}>{label}</span>,
      );
      at = end;
    }
    parts.push(child.slice(at));
    return parts;
  });
}

export function MessageText({ text, members, onTag }: { text: string; members: Mentionable[]; onTag?: (name: string) => void }) {
  const prose = (Tag: "p" | "strong" | "em" | "del") =>
    function Prose({ children }: { children?: ReactNode }) {
      return <Tag>{withMentions(children, members, onTag)}</Tag>;
    };
  const components: Components = {
    p: prose("p"),
    strong: prose("strong"),
    em: prose("em"),
    del: prose("del"),
    a: ({ href, children }) =>
      href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky underline">{children}</a> : <>{children}</>,
    code: ({ children, className }) => (
      <code className={`${className ?? ""} rounded bg-surface-3 px-1 font-mono text-[0.9em]`}>{children}</code>
    ),
    pre: ({ children }) => <pre className="overflow-x-auto rounded-md bg-surface-3 p-2">{children}</pre>,
  };
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
