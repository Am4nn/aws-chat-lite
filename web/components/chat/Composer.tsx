"use client";

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useParams } from "next/navigation";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { mentionOptions, mentionQuery, type Mentionable } from "@/lib/client/mentions";
import { useEscape } from "@/lib/client/useEscape";
import { dur, easeOut, instant } from "@/lib/motion";
import type { Message } from "@/lib/types";
import { UploadChip } from "./Attachments";
import { MentionList } from "./MentionList";
import { DictationRow, isDictating, MicButton } from "./MicButton";
import { ModeBanner } from "./ModeBanner";
import { transcriptText } from "@/lib/client/voice/transcript";
import { useDictation } from "./useDictation";
import type { useUploads } from "./useUploads";

export type ComposerMode = { kind: "reply" | "edit"; message: Message } | null;
/** `insertTag`: puts a `#tag` in at the caret, the way a chat message is aimed at a thread. */
export type ComposerHandle = { insertTag: (tag: string) => void };

const MAX_TEXT = 4000;
const COUNTER_FROM = 3600;
const TYPING_EVERY_MS = 3000;
const MAX_HEIGHT_PX = 200;

/** Spoken words go in at the caret, with a space on either side unless one is already there. */
function withWords(text: string, caret: number, words: string) {
  if (!words) return { value: text, caret };
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const head = before && !/\s$/.test(before) ? `${before} ${words}` : before + words;
  return { value: head + (after && !/^\s/.test(after) ? ` ${after}` : after), caret: head.length };
}

/**
 * `agents`: the room's agents, offered first in the @ list where naming one starts a thread with it (a people chat).
 * `mode`: reply or edit, where the view offers them (`onModeChange`); ArrowUp in an empty box edits
 * my last message when `onEditLast` finds one. `uploads`: absent where files can't be sent, which hides the paperclip.
 * `steering`: an agent is running here, so a message steers it, and Stop (`onStop`) sits beside Send. `pill`: the model
 * choice, left of Send.
 */
type Props = {
  ref?: Ref<ComposerHandle>; members: Mentionable[]; agents?: { name: string }[]; meId: string; mode?: ComposerMode;
  uploads?: ReturnType<typeof useUploads>; placeholder?: string; steering?: boolean; stopping?: boolean; pill?: ReactNode;
  onModeChange?: (mode: ComposerMode) => void; onSend: (text: string) => void; onSaveEdit?: (m: Message, text: string) => void;
  onEditLast?: () => boolean; onTyping: () => void; onStop?: () => void;
};

export function Composer({
  ref, members, agents = [], meId, mode = null, uploads, placeholder = "Message", steering = false, stopping = false, pill,
  onModeChange, onSend, onSaveEdit, onEditLast, onTyping, onStop,
}: Props) {
  const reduced = useReducedMotion();
  const { roomId } = useParams<{ roomId: string }>();
  const listId = useId();
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

  const dictation = useDictation({ roomId, onText: insertDictation });
  const dictating = isDictating(dictation);
  useEscape(dictation.state !== "idle", dictation.cancel);

  const query = mentionQuery(text.slice(0, caret));
  const options = query && query.start !== dismissedAt ? mentionOptions(query.query, { agents, members, meId }) : [];

  const editing = mode?.kind === "edit" ? mode.message : undefined;
  const trimmed = text.trim();
  const canSubmit = trimmed.length <= MAX_TEXT && !uploads?.busy && !dictating &&
    (editing ? !!trimmed || editing.attachments.length > 0 : !!trimmed || !!uploads?.uploads.length);

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

  function insertDictation(words: string) {
    const spoken = withWords(text, caret, words);
    nextCaret.current = spoken.caret;
    change(spoken.value, spoken.caret);
    area.current?.focus();
  }

  // A tag aims the message at a thread, so it ends a reply or an edit; an edit's tag goes into the draft it hands back.
  function insertTag(tag: string) {
    const base = editing ? draft : text;
    const at = editing ? base.length : Math.min(caret, base.length);
    const before = base.slice(0, at);
    const head = `${before && !/\s$/.test(before) ? `${before} ` : before}${tag} `;
    const value = head + base.slice(at).trimStart();
    nextCaret.current = head.length;
    if (editing) {
      setDraft(value);
      setCaret(head.length);
    } else {
      change(value, head.length);
    }
    onModeChange?.(null);
    area.current?.focus();
  }
  useImperativeHandle(ref, () => ({ insertTag }));

  function submit() {
    if (!canSubmit) return;
    if (editing) onSaveEdit?.(editing, trimmed);
    else onSend(trimmed);
    setText(editing ? draft : "");
    onModeChange?.(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // A prevented key was already handled, such as the Escape that cancelled a dictation.
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    if (options.length) {
      const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (move) {
        e.preventDefault();
        return setHighlight((h) => (h + move + options.length) % options.length);
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        return insertMention(options[highlight].name);
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
      onModeChange?.(null);
    } else if (e.key === "ArrowUp" && !text && !mode && onEditLast?.()) {
      e.preventDefault();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files];
    if (!files.length || editing || !uploads) return;
    e.preventDefault();
    uploads.add(files);
  }

  const motionFast = reduced ? instant : { duration: dur.fast, ease: easeOut };

  return (
    <div className="relative mx-auto w-full max-w-[836px] px-4 pb-5 sm:px-7">
      <MentionList id={listId} options={options} highlight={highlight} onPick={insertMention} onHighlight={setHighlight} />

      <div className={`rounded-2xl border bg-surface-2 transition-colors duration-300 ${steering ? "border-lime-line" : "border-line-strong focus-within:border-line-hover"}`}>
        <ModeBanner mode={mode} onCancel={() => onModeChange?.(null)} />

        {uploads && uploads.uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            <AnimatePresence initial={false}>
              {uploads.uploads.map((u) => <UploadChip key={u.id} upload={u} onRemove={() => uploads.remove(u.id)} />)}
            </AnimatePresence>
          </div>
        )}

        <AnimatePresence initial={false}>
          {dictation.state === "error" && (
            <motion.div
              initial={reduced ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={motionFast}
              className="overflow-hidden"
            >
              <DictationRow dictation={dictation} />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-end gap-1.5 p-2">
          {uploads && (
            <>
              <button
                onClick={() => fileInput.current?.click()}
                disabled={!!editing}
                aria-label="Attach files"
                className="grid size-[38px] shrink-0 place-items-center rounded-[11px] text-text-3 transition-[background,color,scale] hover:bg-surface-3 hover:text-text active:scale-95 disabled:pointer-events-none disabled:opacity-40"
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
            </>
          )}
          <MicButton dictation={dictation} />
          <label htmlFor="composer" className="sr-only">{steering ? "Steer the agent" : "Message"}</label>
          <textarea
            id="composer"
            ref={area}
            rows={1}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={options.length > 0}
            aria-controls={options.length ? listId : undefined}
            aria-activedescendant={options.length ? `${listId}-${highlight}` : undefined}
            value={dictating ? withWords(text, caret, transcriptText(dictation.live)).value : text}
            readOnly={dictating}
            placeholder={editing ? "Edit your message" : steering ? "Steer the agent…" : placeholder}
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
          {pill}
          <AnimatePresence initial={false}>
            {steering && onStop && (
              <motion.button
                key="stop"
                initial={{ opacity: 0, scale: reduced ? 1 : 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: reduced ? 1 : 0.8 }}
                transition={motionFast}
                onClick={onStop}
                disabled={stopping}
                aria-label="Stop the run"
                title="Stop the run"
                className="grid size-[38px] shrink-0 place-items-center rounded-[11px] border border-line-strong bg-surface-3 text-text transition-[background,border-color,scale] hover:border-line-hover hover:bg-surface-4 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
              >
                <Square aria-hidden="true" size={12} fill="currentColor" strokeWidth={0} />
              </motion.button>
            )}
          </AnimatePresence>
          <button
            onClick={submit}
            disabled={!canSubmit}
            aria-label={editing ? "Save edit" : steering ? "Steer the running agent" : "Send"}
            className="grid size-[38px] shrink-0 place-items-center rounded-[11px] bg-lime text-lime-ink transition-[background,color,scale] hover:bg-lime-soft active:scale-95 disabled:bg-surface-3 disabled:text-text-3"
          >
            <ArrowUp aria-hidden="true" size={16} strokeWidth={2.6} />
          </button>
        </div>
      </div>
      <AnimatePresence>
        {steering && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? instant : { duration: dur.base }}
            className="pointer-events-none absolute inset-x-0 bottom-[3px] text-center font-mono text-[11px] text-text-4 max-sm:hidden"
          >
            Enter steers the running agent
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
