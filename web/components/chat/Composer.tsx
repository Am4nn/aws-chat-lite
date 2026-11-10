"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUp, Paperclip, Pencil, Reply, Users, X } from "lucide-react";
import { mentionQuery, type Mentionable } from "@/lib/client/mentions";
import { dur, easeOut, instant } from "@/lib/motion";
import type { Message } from "@/lib/types";
import { Avatar } from "@/components/ui/Avatar";
import { UploadChip } from "./Attachments";
import type { useUploads } from "./useUploads";

export type ComposerMode = { kind: "reply" | "edit"; message: Message } | null;

const MAX_TEXT = 4000;
const COUNTER_FROM = 3600;
const TYPING_EVERY_MS = 3000;
const MAX_HEIGHT_PX = 200;
const MENTION_OPTIONS = 6;

type Props = {
  members: Mentionable[]; meId: string; mode: ComposerMode; uploads: ReturnType<typeof useUploads>;
  onModeChange: (mode: ComposerMode) => void; onSend: (text: string) => void; onSaveEdit: (m: Message, text: string) => void;
  onEditLast: () => boolean; onTyping: () => void;
};

export function Composer({ members, meId, mode, uploads, onModeChange, onSend, onSaveEdit, onEditLast, onTyping }: Props) {
  const reduced = useReducedMotion();
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const nextCaret = useRef<number | null>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // Editing borrows the box: the unsent draft is put aside and comes back when the edit ends.
  const [shownMode, setShownMode] = useState(mode);
  const [draft, setDraft] = useState("");
  if (mode !== shownMode) {
    setShownMode(mode);
    if (mode?.kind === "edit") {
      if (shownMode?.kind !== "edit") setDraft(text);
      setText(mode.message.text);
    } else if (shownMode?.kind === "edit") {
      setText(draft);
    }
  }

  useEffect(() => {
    const el = area.current;
    if (!mode || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [mode]);

  useLayoutEffect(() => {
    const el = area.current!;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    if (nextCaret.current !== null) {
      el.setSelectionRange(nextCaret.current, nextCaret.current);
      nextCaret.current = null;
    }
  }, [text]);

  const query = mentionQuery(text.slice(0, caret));
  const options = query && query.start !== dismissedAt
    ? ["everyone", ...members.filter((m) => m.userId !== meId).map((m) => m.username)]
      .filter((name) => name.toLowerCase().startsWith(query.query.toLowerCase()))
      .slice(0, MENTION_OPTIONS)
    : [];

  const editing = mode?.kind === "edit" ? mode.message : undefined;
  const trimmed = text.trim();
  const canSubmit = trimmed.length <= MAX_TEXT && !uploads.busy &&
    (editing ? !!trimmed || editing.attachments.length > 0 : !!trimmed || uploads.uploads.length > 0);

  function change(value: string, caretAt: number) {
    setText(value);
    setCaret(caretAt);
    setHighlight(0);
    if (value && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
      lastTyping.current = Date.now();
      onTyping();
    }
  }

  function insertMention(name: string) {
    if (!query) return;
    const before = `${text.slice(0, query.start)}@${name} `;
    nextCaret.current = before.length;
    change(before + text.slice(caret), before.length);
  }

  function submit() {
    if (!canSubmit) return;
    if (editing) onSaveEdit(editing, trimmed);
    else onSend(trimmed);
    setText(editing ? draft : "");
    onModeChange(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (options.length) {
      const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (move) {
        e.preventDefault();
        return setHighlight((h) => (h + move + options.length) % options.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return insertMention(options[highlight]);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setDismissedAt(query!.start);
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && mode) {
      e.preventDefault();
      onModeChange(null);
    } else if (e.key === "ArrowUp" && !text && !mode && onEditLast()) {
      e.preventDefault();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files];
    if (!files.length || editing) return;
    e.preventDefault();
    uploads.add(files);
  }

  const motionFast = reduced ? instant : { duration: dur.fast, ease: easeOut };

  return (
    <div className="relative mx-auto w-full max-w-[836px] px-4 pb-5 sm:px-7">
      <AnimatePresence>
        {options.length > 0 && (
          <motion.ul
            role="listbox"
            aria-label="Mention someone"
            initial={{ opacity: 0, y: reduced ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: motionFast }}
            transition={motionFast}
            className="absolute bottom-full left-4 z-20 mb-2 w-64 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-[0_16px_40px_rgba(0,0,0,.5)] sm:left-7"
          >
            {options.map((name, i) => (
              <li
                key={name}
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => { e.preventDefault(); insertMention(name); }}
                onMouseEnter={() => setHighlight(i)}
                className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-[13px] ${i === highlight ? "bg-surface-3 text-text" : "text-text-2"}`}
              >
                {name === "everyone"
                  ? <span className="grid size-[22px] place-items-center rounded-full bg-[#1c2225]"><Users aria-hidden="true" size={12} /></span>
                  : <Avatar name={name} size={22} />}
                {name}
                {name === "everyone" && <span className="ml-auto text-[11.5px] text-text-3">whole room</span>}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>

      <div className="rounded-2xl border border-line-strong bg-surface-2 transition-colors focus-within:border-[#36403f]">
        <AnimatePresence initial={false}>
          {mode && (
            <motion.div
              key={mode.kind}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2 px-4 pt-2.5 text-[12.5px] text-text-2">
                {mode.kind === "reply" ? <Reply aria-hidden="true" size={13} className="shrink-0 text-text-3" /> : <Pencil aria-hidden="true" size={12} className="shrink-0 text-text-3" />}
                {mode.kind === "reply"
                  ? <span className="min-w-0 truncate">Replying to <b className="font-semibold text-text">{mode.message.authorName}</b> <span className="text-text-3">{mode.message.text}</span></span>
                  : <span>Editing message</span>}
                <kbd className="ml-auto shrink-0 font-mono text-[11px] text-text-3">Esc</kbd>
                <button onClick={() => onModeChange(null)} aria-label="Cancel" className="grid size-6 shrink-0 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-3 hover:text-text">
                  <X aria-hidden="true" size={13} />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {uploads.uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            <AnimatePresence initial={false}>
              {uploads.uploads.map((u) => <UploadChip key={u.id} upload={u} onRemove={() => uploads.remove(u.id)} />)}
            </AnimatePresence>
          </div>
        )}

        <div className="flex items-end gap-1.5 py-2 pl-2 pr-2">
          <button
            onClick={() => fileInput.current?.click()}
            disabled={!!editing}
            aria-label="Attach files"
            className="grid size-[38px] shrink-0 place-items-center rounded-[11px] text-text-3 transition-[background,color,transform] hover:bg-surface-3 hover:text-text active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            <Paperclip aria-hidden="true" size={17} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => { uploads.add([...(e.target.files ?? [])]); e.target.value = ""; }}
          />
          <label htmlFor="composer" className="sr-only">Message</label>
          <textarea
            id="composer"
            ref={area}
            rows={1}
            value={text}
            placeholder={editing ? "Edit your message" : "Message"}
            onChange={(e) => change(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="min-h-[38px] flex-1 resize-none bg-transparent px-1 py-[8px] text-[14.5px] leading-[22px] text-text outline-none placeholder:text-text-3"
          />
          {trimmed.length > COUNTER_FROM && (
            <span className={`self-center font-mono text-[11px] ${trimmed.length > MAX_TEXT ? "text-amber" : "text-text-3"}`}>
              {trimmed.length}/{MAX_TEXT}
            </span>
          )}
          <button
            onClick={submit}
            disabled={!canSubmit}
            aria-label={editing ? "Save edit" : "Send"}
            className="grid size-[38px] shrink-0 place-items-center rounded-[11px] bg-lime text-lime-ink transition-[background,color,transform] hover:bg-[#d7fa8a] active:scale-95 disabled:bg-surface-3 disabled:text-text-3"
          >
            <ArrowUp aria-hidden="true" size={16} strokeWidth={2.6} />
          </button>
        </div>
      </div>
    </div>
  );
}
