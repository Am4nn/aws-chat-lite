"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Past four lines, or about four lines' worth of one paragraph, an answer is cut to its first four, since the agent's
 * own answer below already builds on it.
 */
const SHORT_LINES = 4;
const SHORT_CHARS = 400;

/** What a helper agent reported back to the agent that asked it, under the hand-off's own steps. */
export function HelperAnswer({ agentName, text }: { agentName: string; text: string }) {
  const [full, setFull] = useState(false);
  const count = text.split("\n").length;
  const long = count > SHORT_LINES || text.length > SHORT_CHARS;
  return (
    <div className="ml-10 mr-3 mt-2">
      <p className="mb-1 text-[11.5px] font-medium text-text-3">{agentName}&apos;s answer</p>
      <pre className={`whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.6] text-output-text ${long && !full ? "line-clamp-4" : ""}`}>
        {text || "No answer."}
      </pre>
      {long && (
        <button
          onClick={() => setFull(!full)}
          aria-expanded={full}
          className="-ml-1 mt-1 flex h-7 items-center gap-1 rounded-md px-1 font-mono text-[11.5px] text-text-3 transition-colors hover:bg-surface-3 hover:text-text"
        >
          <ChevronRight aria-hidden="true" size={12} className={`transition-transform duration-300 ${full ? "rotate-90" : ""}`} />
          {full ? "Show less" : count > SHORT_LINES ? `Show all · ${count} lines` : "Show all"}
        </button>
      )}
    </div>
  );
}
