"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Bot, Hash, Search, X } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { matchSnippet, shortWhen } from "@/lib/client/format";
import { searchPlace } from "@/lib/client/searchPlace";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { useTimeZone } from "@/lib/client/useTimeZone";
import { dur, easeOut, instant } from "@/lib/motion";
import type { Chat, Message } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";

const DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

type Found = { query: string; results: Message[] };

/** Results in the order the server ranked them (newest first), gathered under the chat or thread each one is in. */
function byChat(results: Message[]) {
  const groups = new Map<string, Message[]>();
  for (const m of results) groups.set(m.chatId, [...(groups.get(m.chatId) ?? []), m]);
  return [...groups];
}

/**
 * Keyword search across the room's chats and agent threads. Typing waits for a pause before asking, the last answer stays on screen
 * while the next one loads (so the list never blanks between keystrokes), and an answer to an older query is dropped.
 * `focusSignal` changes whenever search is opened, so the field takes focus even if the tab was already showing.
 */
export function SearchPanel({ roomId, chats, serverTimeZone, focusSignal, onPick }: {
  roomId: string; chats: Chat[]; serverTimeZone: string; focusSignal: number; onPick: () => void;
}) {
  const router = useRouter();
  const { threads } = useThreads();
  const reduced = useReducedMotion();
  const timeZone = useTimeZone(serverTimeZone);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim();
  // An error belongs to the query that caused it, so a new query starts without one.
  const changeQuery = (value: string) => {
    setQuery(value);
    setError(null);
  };
  const searchable = q.length >= MIN_QUERY;

  // preventScroll: the panel may still be sliding open, and focusing would scroll its clipped column sideways.
  useEffect(() => input.current?.focus({ preventScroll: true }), [focusSignal]);

  useEffect(() => {
    if (!searchable) return;
    let current = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const { results } = await bff<{ results: Message[] }>(`/bff/api/rooms/${roomId}/search?q=${encodeURIComponent(q)}`);
        if (current) {
          setFound({ query: q, results });
          setError(null);
        }
      } catch (e) {
        if (current) setError(errorText(e));
      } finally {
        // A superseded request leaves the flag to the one that replaced it; the spinner only shows while searchable.
        if (current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [roomId, q, searchable]);

  const place = (m: Message) => searchPlace(roomId, m.chatId, m.seq, chats, threads);
  const shown = searchable ? found : null;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex h-[38px] items-center gap-2 rounded-[10px] border border-line-strong bg-surface-2 px-3 transition-colors focus-within:border-lime/60 hover:border-line-hover">
        <Search aria-hidden="true" size={15} className="shrink-0 text-text-3" />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          placeholder="Search messages"
          aria-label="Search messages"
          className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-text-3 [&::-webkit-search-cancel-button]:hidden"
        />
        <span className="grid size-5 shrink-0 place-items-center text-text-3">
          {loading && searchable
            ? <Spinner />
            : query && (
              <button
                onClick={() => { changeQuery(""); input.current?.focus(); }}
                aria-label="Clear search"
                className="grid size-5 place-items-center rounded-md transition-colors hover:bg-surface-3 hover:text-text"
              >
                <X aria-hidden="true" size={13} />
              </button>
            )}
        </span>
      </label>

      {error && searchable && <p role="alert" className="px-1 text-[12.5px] text-amber">{error}</p>}
      {!shown && (
        <p className="px-1 text-[12.5px] leading-relaxed text-text-3">
          {q.length === 1 ? "Keep typing: at least 2 characters." : "Finds words in the latest messages of every chat."}
        </p>
      )}
      {shown && shown.results.length === 0 && <p className="px-1 text-[12.5px] text-text-3">No messages match &ldquo;{shown.query}&rdquo;.</p>}

      <AnimatePresence mode="popLayout" initial={false}>
        {shown && shown.results.length > 0 && (
          <motion.div
            key={shown.query}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
            className="flex flex-col gap-3"
          >
            {byChat(shown.results).map(([chatId, messages]) => {
              const { kind, label } = place(messages[0]);
              return (
                <section key={chatId} aria-label={kind === "chat" ? `#${label}` : label}>
                  <h3 className="flex items-center gap-1 px-1 pb-1 text-[11.5px] font-semibold text-text-3">
                    {kind === "chat" ? <Hash aria-hidden="true" size={12} /> : <Bot aria-hidden="true" size={12} />}{label}
                  </h3>
                  <ul className="flex flex-col gap-0.5">
                    {messages.map((m) => {
                      const s = matchSnippet(m.text, shown.query);
                      return (
                        <li key={m.seq}>
                          <button
                            onClick={() => { onPick(); router.push(place(m).href); }}
                            className="w-full rounded-[10px] px-2.5 py-2 text-left transition-[background-color,transform] hover:bg-surface-2 active:scale-[0.99]"
                          >
                            <span className="flex items-baseline gap-2">
                              <span className="truncate text-[12.5px] font-semibold">{m.authorName}</span>
                              <time dateTime={m.createdAt} className="ml-auto shrink-0 font-mono text-[11px] text-text-3">{shortWhen(m.createdAt, Date.now(), timeZone)}</time>
                            </span>
                            <span className="mt-0.5 line-clamp-2 block break-words text-[13px] leading-snug text-text-2">
                              {s.before}{s.match && <mark className="rounded-[3px] bg-lime-flash px-0.5 text-lime">{s.match}</mark>}{s.after}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
