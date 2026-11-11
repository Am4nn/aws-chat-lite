"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Hash, Paperclip } from "lucide-react";
import { errorText } from "@/lib/client/bff";
import { excerpt } from "@/lib/client/format";
import { useLive, useLiveStatus } from "@/lib/client/LiveProvider";
import { canEditLast, withReaction } from "@/lib/client/messageRules";
import { addPending, dropPending, failPending, keyOf, newestSeq, updateMessage, type PendingMessage } from "@/lib/client/timeline";
import { useTimeZone } from "@/lib/client/useTimeZone";
import { dur, instant } from "@/lib/motion";
import type { Attachment, Me, Member, Message, Reaction, Role } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { ArchivedNotice } from "./ArchivedNotice";
import { Composer, type ComposerMode } from "./Composer";
import { MessageList } from "./MessageList";
import type { Row, RowActions, RowContext } from "./MessageRow";
import { TypingLine } from "./TypingLine";
import { useChatTimeline } from "./useChatTimeline";
import { useUploads } from "./useUploads";

const READ_DEBOUNCE_MS = 1000;
const READ_RETRY_MS = 5000;
const CLOCK_TICK_MS = 30_000;

const subscribeVisibility = (fn: () => void) => {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
};

const revokePreviews = (attachments: Attachment[]) =>
  attachments.forEach((a) => a.url?.startsWith("blob:") && URL.revokeObjectURL(a.url));

/** Acks fail for three reasons; only "not connected" is certain the message never reached the server. */
function sendError(e: unknown): string {
  const reason = errorText(e);
  if (reason === "not connected") return "Not connected, so it wasn't sent.";
  if (reason === "timeout" || reason === "connection closed") return "The server didn't confirm it. Check before retrying.";
  return reason;
}

type Props = {
  roomId: string; chatId: string; chatName: string; roomName: string; me: Me; role: Role; members: Member[];
  archived: boolean; initial: Message[]; serverTimeZone: string;
};

export function ChatView({ roomId, chatId, chatName, roomName, me, role, members, archived, initial, serverTimeZone }: Props) {
  const live = useLive();
  const status = useLiveStatus();
  const toast = useToast();
  const reduced = useReducedMotion();
  const timeZone = useTimeZone(serverTimeZone);
  const uploads = useUploads(roomId);
  const chat = useChatTimeline({ roomId, chatId, meId: me.userId, initial });
  const { timeline, setTimeline, latest, apply, markFresh, refetchAround, hasNewer, showLatest, jumpTo, scrollToBottom } = chat;
  const [mode, setMode] = useState<ComposerMode>(null);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => latest.current.pending.forEach((p) => revokePreviews(p.attachments)), [latest]);

  // `?m=<seq>` (a search result) jumps to that message. It is dropped from the address afterwards, so clicking the
  // same result again is a real change that jumps again, and a reload opens at the newest messages.
  const target = Number(useSearchParams().get("m"));
  useEffect(() => {
    if (!Number.isInteger(target) || target < 1) return;
    void jumpTo(target);
    window.history.replaceState(null, "", window.location.pathname);
  }, [target, jumpTo]);

  // Only a confirmed read counts, so one sent before the socket opened (or lost in a drop) is sent again once it's up,
  // and a refused or timed-out one is tried again after a pause rather than waiting for the next message.
  const lastRead = useRef(0);
  const [readFailures, setReadFailures] = useState(0);
  const newest = newestSeq(timeline);
  useEffect(() => {
    if (status !== "open" || !chat.pinned || hasNewer || !visible || newest <= lastRead.current) return;
    const timer = setTimeout(() => {
      live.request("read", { roomId, chatId, seq: newest })
        .then(() => { lastRead.current = Math.max(lastRead.current, newest); }, () => setReadFailures((n) => n + 1));
    }, readFailures ? READ_RETRY_MS : READ_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [status, chat.pinned, hasNewer, visible, newest, live, roomId, chatId, readFailures]);

  const deliver = useCallback(async (p: PendingMessage) => {
    try {
      const message = await live.request("send", {
        roomId, chatId, clientId: p.clientId, text: p.text, replyToSeq: p.replyTo?.seq,
        attachments: p.attachments.map(({ key, name, size, type }) => ({ key, name, size, type })),
      }) as Message;
      apply([message]);
      revokePreviews(p.attachments);
    } catch (e) {
      // Sends aren't idempotent, so a failure is shown and left to the user: an automatic resend could post twice.
      setTimeline((t) => failPending(t, p.clientId));
      toast(sendError(e), "error");
    }
  }, [live, roomId, chatId, apply, setTimeline, toast]);

  const queue = useCallback((p: Omit<PendingMessage, "clientId" | "createdAt">) => {
    const pending = { ...p, clientId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    markFresh([keyOf(pending)]);
    setTimeline((t) => addPending(t, pending));
    scrollToBottom();
    void deliver(pending);
  }, [deliver, markFresh, setTimeline, scrollToBottom]);

  function send(text: string) {
    if (hasNewer) void showLatest();
    const quoted = mode?.kind === "reply" ? mode.message : undefined;
    queue({
      text, attachments: uploads.take(),
      replyTo: quoted && { seq: quoted.seq, authorName: quoted.authorName, excerpt: excerpt(quoted.text) },
    });
  }

  /** Shown at once; a refusal puts the old text back only if nothing else has changed the message since. */
  async function saveEdit(m: Message, text: string) {
    if (text === m.text) return;
    setTimeline((t) => updateMessage(t, m.seq, (x) => ({ ...x, text, editedAt: new Date().toISOString() })));
    try {
      apply([await live.request("edit", { roomId, chatId, seq: m.seq, text }) as Message]);
    } catch (e) {
      setTimeline((t) => updateMessage(t, m.seq, (x) => (x.text === text ? { ...x, text: m.text, editedAt: m.editedAt } : x)));
      toast(errorText(e), "error");
    }
  }

  const actions = useMemo<RowActions>(() => ({
    async react(m: Message, reaction: Reaction, on: boolean) {
      const toggle = (state: boolean) => setTimeline((t) => updateMessage(t, m.seq, (x) => withReaction(x, reaction, me.userId, state)));
      toggle(on);
      try {
        apply([await live.request("react", { roomId, chatId, seq: m.seq, reaction, on }) as Message]);
      } catch (e) {
        toggle(!on);
        toast(errorText(e), "error");
      }
    },
    reply: (m: Message) => setMode({ kind: "reply", message: m }),
    edit: (m: Message) => setMode({ kind: "edit", message: m }),
    async remove(m: Message) {
      try {
        apply([await live.request("delete", { roomId, chatId, seq: m.seq }) as Message]);
      } catch (e) {
        toast(errorText(e), "error");
      }
    },
    jump: (seq: number) => void jumpTo(seq),
    refetch: (seq: number) => void refetchAround(seq),
    retry(clientId: string) {
      const failed = latest.current.pending.find((p) => p.clientId === clientId);
      if (!failed) return;
      setTimeline((t) => dropPending(t, clientId));
      queue({ text: failed.text, attachments: failed.attachments, replyTo: failed.replyTo });
    },
    discard(clientId: string) {
      const failed = latest.current.pending.find((p) => p.clientId === clientId);
      if (failed) revokePreviews(failed.attachments);
      setTimeline((t) => dropPending(t, clientId));
    },
  }), [me.userId, live, roomId, chatId, apply, setTimeline, latest, toast, jumpTo, refetchAround, queue]);

  const ctx = useMemo<RowContext>(
    () => ({ meId: me.userId, role, members, now, timeZone, readOnly: archived }),
    [me.userId, role, members, now, timeZone, archived],
  );

  // Two memos, so a new message doesn't rebuild the pending rows' messages (and re-render them) or the reverse.
  const storedRows = useMemo(() => timeline.messages.map((m): Row => ({ key: keyOf(m), message: m })), [timeline.messages]);
  const pendingRows = useMemo(() => timeline.pending.map((p): Row => ({
    key: keyOf(p),
    status: p.failed ? "failed" : "pending",
    message: {
      roomId, chatId, seq: 0, authorId: me.userId, authorName: me.username, clientId: p.clientId, text: p.text,
      createdAt: p.createdAt, replyTo: p.replyTo, attachments: p.attachments, reactions: {}, mentions: [], everyone: false,
    },
  })), [timeline.pending, roomId, chatId, me]);
  const rows = useMemo(() => [...storedRows, ...pendingRows], [storedRows, pendingRows]);

  const hasFiles = (e: DragEvent) => !archived && e.dataTransfer.types.includes("Files");

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        uploads.add([...e.dataTransfer.files]);
      }}
    >
      <MessageList
        rows={rows} ctx={ctx} actions={actions} fresh={chat.fresh}
        editingKey={mode?.kind === "edit" ? keyOf(mode.message) : undefined}
        hasOlder={chat.hasOlder} hasNewer={hasNewer} loadingOlder={chat.loadingOlder} olderFailed={chat.olderFailed}
        jump={chat.jump} unseen={chat.unseen}
        onLoadOlder={chat.loadOlder} onLoadNewer={chat.loadNewer} onPinnedChange={chat.onPinnedChange} onShowLatest={showLatest}
        intro={<ChatIntro chatName={chatName} roomName={roomName} />}
      />
      <TypingLine roomId={roomId} chatId={chatId} meId={me.userId} />
      {archived
        ? <ArchivedNotice />
        : (
          <Composer
            members={members} meId={me.userId} mode={mode} uploads={uploads} onModeChange={setMode}
            onSend={send} onSaveEdit={saveEdit}
            onEditLast={() => {
              const m = canEditLast(timeline.messages, me.userId, Date.now());
              if (m) setMode({ kind: "edit", message: m });
              return !!m;
            }}
            onTyping={() => live.request("typing", { roomId, chatId }).catch(() => {})}
          />
        )}
      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? instant : { duration: dur.fast }}
            className="pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-2xl border border-dashed border-[#3b5420] bg-ink/85"
          >
            <span className="flex items-center gap-2 text-[14px] text-text-2">
              <Paperclip aria-hidden="true" size={16} className="text-lime" />
              Drop to attach
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ChatIntro({ chatName, roomName }: { chatName: string; roomName: string }) {
  return (
    <div className="px-3 pb-2 pt-10">
      <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-surface-3 text-text-2">
        <Hash aria-hidden="true" size={22} />
      </span>
      <h2 className="font-display text-[27px] font-bold tracking-tight">Welcome to #{chatName}</h2>
      <p className="mt-1.5 text-[15px] text-text-2">This is the start of the conversation in {roomName}.</p>
    </div>
  );
}
