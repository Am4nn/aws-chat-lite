"use client";

import { memo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CircleAlert, CornerUpLeft, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";
import { clockTime } from "@/lib/client/format";
import type { Mentionable } from "@/lib/client/mentions";
import { canDelete, canEdit, REACTION_NAMES, reactionLabel } from "@/lib/client/messageRules";
import { useClickOutside } from "@/lib/client/useClickOutside";
import { useNow } from "@/lib/client/useNow";
import { dur, easeOut, instant, spring } from "@/lib/motion";
import type { Message, Reaction, Role } from "@/lib/types";
import { ThreadRef } from "@/components/threads/ThreadCard";
import { Avatar } from "@/components/ui/Avatar";
import { MessageAttachments } from "./Attachments";
import { MessageText } from "./MessageText";

const EMOJI: Record<Reaction, string> = { thumbs: "👍", heart: "❤️", joy: "😂", tada: "🎉", eyes: "👀", check: "✅" };
const REACTIONS = Object.keys(EMOJI) as Reaction[];
/** How often the toolbar re-reads the clock, so Edit and Delete go once their window closes. */
const WINDOW_TICK_MS = 30_000;

export type Row = { key: string; message: Message; status?: "pending" | "failed" };
/** `readOnly`: the room or the chat is archived, so nothing in it can change. */
export type RowContext = { meId: string; role: Role; members: Mentionable[]; timeZone: string; readOnly: boolean };
export type RowActions = {
  react: (m: Message, reaction: Reaction, on: boolean) => void;
  reply: (m: Message) => void;
  replyInThread: (threadId: string) => void;
  edit: (m: Message) => void;
  remove: (m: Message) => void;
  jump: (seq: number) => void;
  refetch: (seq: number) => void;
  retry: (clientId: string) => void;
  discard: (clientId: string) => void;
};

type Props = {
  rowKey: string; message: Message; status: Row["status"]; ctx: RowContext; actions: RowActions;
  groupStart: boolean; enter: boolean; flash?: number; editing: boolean; active: boolean; onActivate: (key: string) => void;
};

/**
 * Memoised on plain props (the message object keeps its identity until it changes), so a busy chat re-renders, and
 * re-parses the markdown of, only the rows that changed.
 */
export const MessageRow = memo(function MessageRow({ rowKey, message: m, status, ctx, actions, groupStart, enter, flash, editing, active, onActivate }: Props) {
  const reduced = useReducedMotion();
  const time = clockTime(m.createdAt, ctx.timeZone);
  const mentionsMe = m.authorId !== ctx.meId && (m.everyone || m.mentions.includes(ctx.meId));
  const settled = !status;

  return (
    <motion.div
      data-key={rowKey}
      data-seq={settled ? m.seq : undefined}
      data-active={active}
      initial={enter ? { opacity: 0, y: reduced ? 0 : 6 } : false}
      animate={{ opacity: status === "pending" ? 0.6 : 1, y: 0 }}
      transition={reduced ? instant : { duration: 0.2, ease: easeOut }}
      onPointerUp={(e) => e.pointerType === "touch" && onActivate(rowKey)}
      className={`group relative rounded-[10px] px-3 transition-colors ${groupStart ? "mt-3 pb-px pt-1" : "py-px"} ${
        editing ? "bg-surface-2" : mentionsMe ? "bg-amber-wash shadow-[inset_2px_0_0_var(--color-amber)]" : "hover:bg-surface-2"
      }`}
    >
      {flash !== undefined && (
        <motion.span
          key={flash}
          aria-hidden="true"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={reduced ? { duration: 0, delay: 1 } : { duration: 1, ease: easeOut }}
          className="pointer-events-none absolute inset-0 rounded-[10px] bg-lime-flash"
        />
      )}
      <div className="relative flex gap-3">
        <div className="w-8 shrink-0">
          {groupStart
            ? <span className="mt-0.5 block"><Avatar name={m.authorName} size={32} /></span>
            : <time dateTime={m.createdAt} title={time} className="block pt-px text-right font-mono text-[10.5px] leading-5 text-text-3 opacity-0 transition-opacity group-hover:opacity-100">{time.split(" ")[0]}</time>}
        </div>
        <div className="min-w-0 flex-1">
          {groupStart && (
            <div className="flex items-baseline gap-2">
              <span className="text-[13.5px] font-semibold">{m.authorName}</span>
              <time dateTime={m.createdAt} className="font-mono text-[11px] text-text-3">{time}</time>
            </div>
          )}
          {m.replyTo && !m.deleted && (
            <button
              onClick={() => actions.jump(m.replyTo!.seq)}
              className="mb-0.5 mt-1 flex max-w-full items-center gap-1.5 border-l-2 border-line-strong pl-2 text-left text-[12.5px] text-text-3 transition-colors hover:border-line-hover hover:text-text-2"
            >
              <CornerUpLeft aria-hidden="true" size={12} className="shrink-0" />
              <span className="shrink-0 font-medium text-text-2">{m.replyTo.authorName}</span>
              <span className="truncate">{m.replyTo.excerpt || "Message deleted"}</span>
            </button>
          )}
          <Body message={m} members={ctx.members} />
          {!m.deleted && <MessageAttachments attachments={m.attachments} onExpired={() => actions.refetch(m.seq)} />}
          {m.threadRef && !m.deleted && (
            <ThreadRef threadRef={m.threadRef} roomId={m.roomId} readOnly={ctx.readOnly} onReply={actions.replyInThread} />
          )}
          {!m.deleted && settled && <Reactions message={m} meId={ctx.meId} members={ctx.members} readOnly={ctx.readOnly} onReact={actions.react} />}
          {status === "failed" && (
            <div className="mt-1 flex items-center gap-2 text-[12px]">
              <CircleAlert aria-hidden="true" size={13} className="text-amber" />
              <span className="text-amber">Not sent</span>
              <button onClick={() => actions.retry(m.clientId!)} className="text-text-2 underline-offset-2 transition-colors hover:text-text hover:underline">Retry</button>
              <button onClick={() => actions.discard(m.clientId!)} className="text-text-3 underline-offset-2 transition-colors hover:text-text-2 hover:underline">Discard</button>
            </div>
          )}
        </div>
      </div>
      {settled && !m.deleted && !ctx.readOnly && <Toolbar message={m} ctx={ctx} actions={actions} pinned={active} />}
    </motion.div>
  );
});

function Body({ message: m, members }: { message: Message; members: Mentionable[] }) {
  if (m.deleted) {
    return <p className="text-[14px] italic text-text-3">{m.deleted === "admin" ? "Removed by an admin" : "Message deleted"}</p>;
  }
  if (!m.text) return null;
  // "(edited)" sits inline after the last paragraph, the way it would read in a sentence.
  return (
    <div className={`break-words text-[14.5px] leading-[1.55] text-text-body [&_p+p]:mt-1.5 [&_pre]:my-1.5 ${m.editedAt ? "[&>p:nth-last-child(2)]:inline" : ""}`}>
      <MessageText text={m.text} members={members} />
      {m.editedAt && <span className="ml-1.5 text-[11.5px] text-text-3">(edited)</span>}
    </div>
  );
}

function Reactions({ message: m, meId, members, readOnly, onReact }: {
  message: Message; meId: string; members: Mentionable[]; readOnly: boolean; onReact: RowActions["react"];
}) {
  const reduced = useReducedMotion();
  const present = REACTIONS.filter((r) => m.reactions[r]?.length);
  if (!present.length) return null;
  const nameOf = (id: string) => (id === meId ? "you" : members.find((x) => x.userId === id)?.username ?? "someone");
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      <AnimatePresence initial={false}>
        {present.map((r) => {
          const users = m.reactions[r]!;
          const mine = users.includes(meId);
          return (
            <motion.button
              key={r}
              initial={{ opacity: 0, scale: reduced ? 1 : 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: reduced ? 1 : 0.6, transition: reduced ? instant : { duration: dur.fast } }}
              transition={reduced ? instant : spring.pop}
              onClick={() => onReact(m, r, !mine)}
              disabled={readOnly}
              aria-pressed={mine}
              aria-label={reactionLabel(r, users.length, mine)}
              title={users.map(nameOf).join(", ")}
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2 text-[13px] transition-colors active:scale-95 disabled:pointer-events-none ${
                mine ? "border-lime-line bg-lime-wash" : "border-line-strong bg-surface-2 hover:border-line-hover"
              }`}
            >
              <span aria-hidden="true">{EMOJI[r]}</span>
              <span className={`font-mono text-[11.5px] ${mine ? "text-lime" : "text-text-2"}`}>{users.length}</span>
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/**
 * Arrow keys move between the buttons of one group (the toolbar, or the emoji picker), so each row costs a keyboard
 * user one Tab stop instead of four: the standard roving-focus toolbar pattern.
 */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[e.key];
  const group = (e.target as HTMLElement).closest("[data-group]");
  if (step === undefined || !group) return;
  e.preventDefault();
  const buttons = [...group.querySelectorAll<HTMLElement>(":scope > button")];
  const at = buttons.indexOf(e.target as HTMLElement);
  const next = Math.abs(step) === Infinity ? (step > 0 ? buttons.length - 1 : 0) : (at + step + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

/** Shown on hover or keyboard focus (or a tap on touch screens), offering only what the server would allow. */
function Toolbar({ message: m, ctx, actions, pinned }: { message: Message; ctx: RowContext; actions: RowActions; pinned: boolean }) {
  const reduced = useReducedMotion();
  const now = useNow(true, WINDOW_TICK_MS);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const smile = useRef<HTMLButtonElement>(null);
  const close = () => { setPicking(false); setConfirming(false); };
  useClickOutside(ref, picking || confirming, close);
  const open = pinned || picking || confirming;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && (picking || confirming)) {
      e.stopPropagation();
      close();
      smile.current?.focus();
    } else {
      moveFocus(e);
    }
  }

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Message actions"
      data-group
      onMouseLeave={() => setConfirming(false)}
      onKeyDown={onKeyDown}
      className={`absolute -top-4 right-3 z-10 flex items-center gap-0.5 rounded-[10px] border border-line-strong bg-surface-2 p-0.5 shadow-pop transition-opacity duration-150 ${
        open ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      }`}
    >
      <AnimatePresence>
        {picking && (
          <motion.div
            role="group"
            aria-label="Reactions"
            data-group
            initial={{ opacity: 0, scale: reduced ? 1 : 0.95, y: reduced ? 0 : 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, transition: reduced ? instant : { duration: dur.fast } }}
            transition={reduced ? instant : { duration: dur.fast, ease: easeOut }}
            style={{ transformOrigin: "bottom right" }}
            className="absolute bottom-full right-0 mb-1.5 flex gap-0.5 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-menu"
          >
            {REACTIONS.map((r, i) => {
              const mine = !!m.reactions[r]?.includes(ctx.meId);
              return (
                <button
                  key={r}
                  autoFocus={i === 0}
                  tabIndex={i === 0 ? 0 : -1}
                  aria-label={`React ${REACTION_NAMES[r]}`}
                  aria-pressed={mine}
                  onClick={() => { close(); smile.current?.focus(); actions.react(m, r, !mine); }}
                  className={`grid size-8 place-items-center rounded-lg text-[17px] transition-[background,transform] hover:bg-surface-3 focus-visible:bg-surface-3 active:scale-90 ${mine ? "bg-lime-wash" : ""}`}
                >
                  {EMOJI[r]}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
      <ToolButton ref={smile} first label="Add reaction" onClick={() => setPicking((p) => !p)} pressed={picking}><SmilePlus aria-hidden="true" size={15} /></ToolButton>
      <ToolButton label="Reply" onClick={() => actions.reply(m)}><Reply aria-hidden="true" size={15} /></ToolButton>
      {canEdit(m, ctx.meId, now) && <ToolButton label="Edit" onClick={() => actions.edit(m)}><Pencil aria-hidden="true" size={14} /></ToolButton>}
      {canDelete(m, ctx.meId, ctx.role, now) && (confirming
        ? (
          <button
            autoFocus
            tabIndex={-1}
            onClick={() => { close(); actions.remove(m); }}
            className="h-7 rounded-lg px-2 text-[12.5px] font-medium text-danger transition-colors hover:bg-danger-wash focus-visible:bg-danger-wash"
          >
            Delete?
          </button>
        )
        : <ToolButton label="Delete" onClick={() => setConfirming(true)}><Trash2 aria-hidden="true" size={14} /></ToolButton>)}
    </div>
  );
}

function ToolButton({ ref, first = false, label, onClick, pressed, children }: {
  ref?: Ref<HTMLButtonElement>; first?: boolean; label: string; onClick: () => void; pressed?: boolean; children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      tabIndex={first ? 0 : -1}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`grid size-7 place-items-center rounded-lg transition-[background,color,transform] hover:bg-surface-3 hover:text-text active:scale-90 ${pressed ? "bg-surface-3 text-text" : "text-text-2"}`}
    >
      {children}
    </button>
  );
}
