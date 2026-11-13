"use client";

import Link from "next/link";
import { memo, useContext, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CircleAlert, CornerUpLeft, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";
import { RoomAgentsContext, useAgentNames } from "@/lib/client/agents";
import { clockTime } from "@/lib/client/format";
import type { Mentionable } from "@/lib/client/mentions";
import { canDelete, canEdit, mentionsMe, REACTION_NAMES, reactionLabel } from "@/lib/client/messageRules";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { useClickOutside } from "@/lib/client/useClickOutside";
import { useNow } from "@/lib/client/useNow";
import { dur, easeOut, instant, spring } from "@/lib/motion";
import type { Message, Reaction, Role } from "@/lib/types";
import { ThreadRef } from "@/components/threads/ThreadCard";
import { AgentAvatar, AiTag } from "@/components/ui/AgentAvatar";
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

/** `groupStart`/`groupEnd`: the row opens or closes a run of one person's messages. */
type Props = {
  rowKey: string; message: Message; status: Row["status"]; ctx: RowContext; actions: RowActions;
  groupStart: boolean; groupEnd: boolean; enter: boolean; flash?: number; editing: boolean; active: boolean;
  onActivate: (key: string) => void;
};

/**
 * A bubble's sharp corner points at its sender. Later bubbles in a group are flatter on that side too, so the run reads as one
 * stack. One radius class per case: Tailwind orders radius classes by value, not by source order, so two would fight.
 */
const shape = (mine: boolean, groupStart: boolean) => mine
  ? groupStart ? "rounded-[16px_16px_6px_16px]" : "rounded-[16px_6px_6px_16px]"
  : groupStart ? "rounded-[16px_16px_16px_6px]" : "rounded-[6px_16px_16px_6px]";

/**
 * A chat-app layout: my messages are bubbles on the right with the time under the group, everyone else's sit on the
 * left under their avatar and name. Memoised on plain props (the message object keeps its identity until it changes),
 * so a busy chat re-renders, and re-parses the markdown of, only the rows that changed.
 */
export const MessageRow = memo(function MessageRow({
  rowKey, message: m, status, ctx, actions, groupStart, groupEnd, enter, flash, editing, active, onActivate,
}: Props) {
  const reduced = useReducedMotion();
  const time = clockTime(m.createdAt, ctx.timeZone);
  const mine = m.authorId === ctx.meId;
  // A schedule's card and an agent's post are the room's automation, not a person.
  const automated = m.authorId === "schedule" || !!m.agentPost;
  const { byId } = useThreads();
  const source = m.agentPost;
  const forMe = mentionsMe(m, ctx.meId);
  const settled = !status;
  const quote = !m.deleted && m.replyTo;
  const hoverTime = (
    <time dateTime={m.createdAt} title={time} className="block shrink-0 font-mono text-[10.5px] leading-5 text-text-3 opacity-0 transition-opacity group-hover:opacity-100">
      {time.split(" ")[0]}
    </time>
  );

  const bubble = (m.deleted || m.text || quote) && (
    <div className={`min-w-0 px-[13px] py-2 ${shape(mine, groupStart)} ${forMe ? "bg-amber-wash ring-1 ring-inset ring-amber-line" : mine ? "bg-surface-3" : "bg-surface-2"}`}>
      {quote && (
        <button
          onClick={() => actions.jump(quote.seq)}
          className="mb-0.5 flex max-w-full items-center gap-1.5 text-left text-[12.5px] text-text-3 transition-[color,opacity] hover:text-text-2 active:opacity-70"
        >
          <CornerUpLeft aria-hidden="true" size={12} className="shrink-0" />
          <span className="shrink-0 font-medium text-text-2">{quote.authorName}</span>
          <span className="truncate">{quote.excerpt || "Message deleted"}</span>
        </button>
      )}
      <Body message={m} members={ctx.members} />
    </div>
  );
  // Under the bubble, on the sender's side: what came of the message and what people made of it.
  const below = (
    <>
      {/* Previews fill their container, so they get a fixed column rather than shrinking to fit around nothing. */}
      {!m.deleted && m.attachments.length > 0 && (
        <div className="w-[320px] max-w-full"><MessageAttachments attachments={m.attachments} onExpired={() => actions.refetch(m.seq)} /></div>
      )}
      {m.threadRef && !m.deleted && (
        <ThreadRef threadRef={m.threadRef} roomId={m.roomId} readOnly={ctx.readOnly} onReply={actions.replyInThread} />
      )}
      {!m.deleted && settled && <Reactions message={m} meId={ctx.meId} members={ctx.members} readOnly={ctx.readOnly} onReact={actions.react} />}
      {status === "failed" && (
        <div className="mt-1 flex items-center gap-2 text-[12px]">
          <CircleAlert aria-hidden="true" size={13} className="text-amber" />
          <span className="text-amber">Not sent</span>
          <button onClick={() => actions.retry(m.clientId!)} className="text-text-2 underline-offset-2 transition-[color,opacity] hover:text-text hover:underline active:opacity-70">Retry</button>
          <button onClick={() => actions.discard(m.clientId!)} className="text-text-3 underline-offset-2 transition-[color,opacity] hover:text-text-2 hover:underline active:opacity-70">Discard</button>
        </div>
      )}
    </>
  );

  return (
    <motion.div
      data-key={rowKey}
      data-seq={settled ? m.seq : undefined}
      data-active={active}
      initial={enter ? { opacity: 0, y: reduced ? 0 : 6 } : false}
      animate={{ opacity: status === "pending" ? 0.6 : 1, y: 0 }}
      transition={reduced ? instant : { duration: 0.2, ease: easeOut }}
      onPointerUp={(e) => e.pointerType === "touch" && onActivate(rowKey)}
      className={`group relative rounded-[10px] px-3 py-px transition-colors ${groupStart ? "mt-3" : ""} ${editing ? "bg-surface-2" : ""}`}
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
      {mine
        ? (
          <div className="relative flex flex-col items-end">
            {groupStart && <span className="sr-only">You</span>}
            <div className="flex max-w-[78%] items-end gap-2">
              {!groupEnd && hoverTime}
              {bubble}
            </div>
            {below}
            {groupEnd && <time dateTime={m.createdAt} className="px-1 pt-0.5 font-mono text-[10.5px] text-text-3">{time}</time>}
          </div>
        )
        : (
          <div className="relative flex gap-2">
            <div className="flex w-7 shrink-0 justify-end">
              {groupStart ? <span className="mt-px">{automated ? <AgentAvatar size={28} /> : <Avatar name={m.authorName} size={28} />}</span> : hoverTime}
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-start">
              {groupStart && (
                <div className="flex max-w-full min-w-0 items-baseline gap-[7px] px-1 pb-0.5">
                  <span className={`shrink-0 text-[12.5px] font-semibold ${automated ? "text-lime" : "text-text-2"}`}>{m.authorName}</span>
                  {automated && <AiTag />}
                  {source && (
                    <Link href={`/r/${m.roomId}/t/${source.number}`} className="min-w-0 truncate text-[12px] text-text-3 transition-colors hover:text-text-2 hover:underline">
                      from #{byId(source.threadId)?.name ?? source.number}
                    </Link>
                  )}
                  <time dateTime={m.createdAt} className="shrink-0 font-mono text-[11px] text-text-3">{time}</time>
                  {forMe && <span aria-label="Mentions you" title="Mentions you" className="font-mono text-[11px] font-semibold text-amber">@</span>}
                </div>
              )}
              <div className="max-w-[85%]">{bubble}</div>
              {below}
            </div>
          </div>
        )}
      {settled && !m.deleted && !ctx.readOnly && <Toolbar message={m} ctx={ctx} actions={actions} pinned={active} />}
    </motion.div>
  );
});

function Body({ message: m, members }: { message: Message; members: Mentionable[] }) {
  const agents = useAgentNames();
  const roomAgents = useContext(RoomAgentsContext);
  const { byId } = useThreads();
  const started = m.threadRef?.kind === "started" ? byId(m.threadRef.threadId) : undefined;
  const lead = started && roomAgents.find((a) => a.agentId === started.agentId)?.name;
  if (m.deleted) {
    return <p className="text-[14px] italic text-text-3">{m.deleted === "admin" ? "Removed by an admin" : "Message deleted"}</p>;
  }
  if (!m.text) return null;
  // "(edited)" sits inline after the last paragraph, the way it would read in a sentence.
  return (
    <div className={`break-words text-[14.5px] leading-[1.55] text-text-body [&_p+p]:mt-1.5 [&_pre]:my-1.5 ${m.editedAt ? "[&>p:nth-last-child(2)]:inline" : ""}`}>
      <MessageText text={m.text} members={members} agents={agents} lead={lead} />
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
  // Over the empty side of the row: on my right-aligned bubbles the right edge is the message itself.
  const own = m.authorId === ctx.meId;
  useClickOutside(ref, picking || confirming, close);
  const open = pinned || picking || confirming;
  // A reply to the message that started a thread is meant for the thread, as its card's Reply is.
  const started = m.threadRef?.kind === "started" ? m.threadRef : undefined;

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
      className={`absolute -top-4 ${own ? "left-3" : "right-3"} z-10 flex items-center gap-0.5 rounded-[10px] border border-line-strong bg-surface-2 p-0.5 shadow-pop transition-opacity duration-150 ${
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
            style={{ transformOrigin: own ? "bottom left" : "bottom right" }}
            className={`absolute bottom-full ${own ? "left-0" : "right-0"} mb-1.5 flex gap-0.5 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-menu`}
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
                  className={`grid size-8 place-items-center rounded-lg text-[17px] transition-[background,scale] hover:bg-surface-3 focus-visible:bg-surface-3 active:scale-90 ${mine ? "bg-lime-wash" : ""}`}
                >
                  {EMOJI[r]}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
      <ToolButton ref={smile} first label="Add reaction" onClick={() => setPicking((p) => !p)} pressed={picking}><SmilePlus aria-hidden="true" size={15} /></ToolButton>
      <ToolButton label="Reply" onClick={() => (started ? actions.replyInThread(started.threadId) : actions.reply(m))}><Reply aria-hidden="true" size={15} /></ToolButton>
      {canEdit(m, ctx.meId, now) && <ToolButton label="Edit" onClick={() => actions.edit(m)}><Pencil aria-hidden="true" size={14} /></ToolButton>}
      {canDelete(m, ctx.meId, ctx.role, now) && (confirming
        ? (
          <button
            autoFocus
            tabIndex={-1}
            onClick={() => { close(); actions.remove(m); }}
            className="h-7 rounded-lg px-2 text-[12.5px] font-medium text-danger transition-[background-color,scale] hover:bg-danger-wash focus-visible:bg-danger-wash active:scale-[0.96]"
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
      className={`grid size-7 place-items-center rounded-lg transition-[background,color,scale] hover:bg-surface-3 hover:text-text active:scale-90 ${pressed ? "bg-surface-3 text-text" : "text-text-2"}`}
    >
      {children}
    </button>
  );
}
