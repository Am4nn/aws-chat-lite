"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Archive, Hash, Paperclip } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { excerpt } from "@/lib/client/format";
import { useLive, useLiveEvent } from "@/lib/client/LiveProvider";
import { canEditLast } from "@/lib/client/messageRules";
import { addPending, applyMessages, dropPending, failPending, newestSeq, type PendingMessage, type Timeline } from "@/lib/client/timeline";
import { useTimeZone } from "@/lib/client/useTimeZone";
import { dur, instant } from "@/lib/motion";
import type { Me, Member, Message, Reaction, Role } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { Composer, type ComposerMode } from "./Composer";
import { MessageList, type Jump } from "./MessageList";
import type { Row, RowActions, RowContext } from "./MessageRow";
import { TypingLine } from "./TypingLine";
import { useUploads } from "./useUploads";

const PAGE = 50;
const READ_DEBOUNCE_MS = 1000;
const CLOCK_TICK_MS = 30_000;

const keyOf = (m: { clientId?: string; seq?: number }) => (m.clientId ? `c:${m.clientId}` : `s:${m.seq}`);

const subscribeVisibility = (fn: () => void) => {
  document.addEventListener("visibilitychange", fn);
  return () => document.removeEventListener("visibilitychange", fn);
};

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

/**
 * One chat: history from the API, live changes from the socket. The timeline normally runs from some older page to
 * the newest message; a jump to an old quote can replace it with a page in the middle ("detached", `hasNewer`),
 * and scrolling down then pages forward until it meets the present again.
 */
export function ChatView({ roomId, chatId, chatName, roomName, me, role, members, archived, initial, serverTimeZone }: Props) {
  const live = useLive();
  const toast = useToast();
  const reduced = useReducedMotion();
  const timeZone = useTimeZone(serverTimeZone);
  const uploads = useUploads(roomId);
  const api = `/bff/api/rooms/${roomId}/chats/${chatId}/messages`;

  const [timeline, setTimeline] = useState<Timeline>({ messages: initial, pending: [] });
  const [fresh, setFresh] = useState(() => new Set<string>());
  const [hasOlder, setHasOlder] = useState((initial[0]?.seq ?? 1) > 1);
  const [hasNewer, setHasNewer] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [mode, setMode] = useState<ComposerMode>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Async paging and the row actions read the timeline through this, so they stay stable while messages stream in.
  const latest = useRef(timeline);
  useEffect(() => { latest.current = timeline; });
  const paging = useRef(false);
  const lastRead = useRef(0);
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const markFresh = (keys: string[]) => setFresh((s) => new Set([...s, ...keys]));
  const apply = useCallback((messages: Message[]) => setTimeline((t) => applyMessages(t, messages)), []);

  const page = useCallback(async (query: string) => (await bff<{ messages: Message[] }>(`${api}${query}`)).messages, [api]);

  /** Fetches forward from `after` until a short page says there is nothing newer. */
  const catchUp = useCallback(async (after: number) => {
    for (let seq = after; ;) {
      const messages = await page(`?after=${seq}`);
      markFresh(messages.map(keyOf));
      apply(messages);
      if (messages.length < PAGE) return;
      seq = messages.at(-1)!.seq;
    }
  }, [apply, page]);

  useLiveEvent("message.new", ({ message: m }) => {
    if (m.chatId !== chatId) return;
    if (m.authorId !== me.userId && (!pinned || hasNewer)) setUnseen((n) => n + 1);
    if (hasNewer) return;
    markFresh([keyOf(m)]);
    apply([m]);
  });
  useLiveEvent("message.updated", ({ message: m }) => {
    if (m.chatId !== chatId) return;
    setTimeline((t) => (t.messages.some((x) => x.seq === m.seq) ? applyMessages(t, [m]) : t));
  });
  // Also fires on the first connect, which covers whatever arrived between the server render and the socket opening.
  useLiveEvent("reconnected", () => {
    if (!hasNewer) catchUp(newestSeq(timeline)).catch((e) => toast(errorText(e), "error"));
  });

  const loadOlder = useCallback(async () => {
    const oldest = latest.current.messages[0]?.seq;
    if (paging.current || !oldest) return;
    paging.current = true;
    setLoadingOlder(true);
    try {
      const messages = await page(`?before=${oldest}`);
      apply(messages);
      setHasOlder((messages[0]?.seq ?? 1) > 1);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      paging.current = false;
      setLoadingOlder(false);
    }
  }, [page, apply, toast]);

  const loadNewer = useCallback(async () => {
    if (paging.current) return;
    paging.current = true;
    try {
      const messages = await page(`?after=${newestSeq(latest.current)}`);
      apply(messages);
      if (messages.length < PAGE) setHasNewer(false);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      paging.current = false;
    }
  }, [page, apply, toast]);

  /** Back to the present: the newest page replaces whatever stretch of history was showing. */
  const showLatest = useCallback(async () => {
    setUnseen(0);
    if (hasNewer) {
      try {
        const messages = await page("");
        setTimeline((t) => ({ messages, pending: t.pending }));
        setHasOlder((messages[0]?.seq ?? 1) > 1);
        setHasNewer(false);
      } catch (e) {
        return toast(errorText(e), "error");
      }
    }
    setJump({ to: "bottom", n: Date.now() });
  }, [hasNewer, page, toast]);

  const jumpTo = useCallback(async (seq: number) => {
    if (!latest.current.messages.some((m) => m.seq === seq)) {
      try {
        const messages = await page(`?around=${seq}`);
        const oldest = latest.current.messages[0]?.seq ?? Infinity;
        // A page that reaches what's loaded joins it; one further back replaces it, leaving newer pages to fetch.
        if ((messages.at(-1)?.seq ?? 0) + 1 >= oldest) {
          apply(messages);
        } else {
          setTimeline((t) => ({ messages, pending: t.pending }));
          setHasNewer(true);
        }
        setHasOlder((messages[0]?.seq ?? 1) > 1);
      } catch (e) {
        return toast(errorText(e), "error");
      }
    }
    setJump({ to: seq, n: Date.now() });
  }, [page, apply, toast]);

  const deliver = useCallback(async (p: PendingMessage) => {
    try {
      const message = await live.request("send", {
        roomId, chatId, clientId: p.clientId, text: p.text, replyToSeq: p.replyTo?.seq,
        attachments: p.attachments.map(({ key, name, size, type }) => ({ key, name, size, type })),
      }) as Message;
      apply([message]);
      p.attachments.forEach((a) => a.url?.startsWith("blob:") && URL.revokeObjectURL(a.url));
    } catch (e) {
      // Sends aren't idempotent, so a failure is shown and left to the user: an automatic resend could post twice.
      setTimeline((t) => failPending(t, p.clientId));
      toast(sendError(e), "error");
    }
  }, [live, roomId, chatId, apply, toast]);

  const queue = useCallback((p: Omit<PendingMessage, "clientId" | "createdAt">) => {
    const pending = { ...p, clientId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    markFresh([keyOf(pending)]);
    setTimeline((t) => addPending(t, pending));
    setJump({ to: "bottom", n: Date.now() });
    void deliver(pending);
  }, [deliver]);

  function send(text: string) {
    if (hasNewer) void showLatest();
    const quoted = mode?.kind === "reply" ? mode.message : undefined;
    queue({
      text, attachments: uploads.take(),
      replyTo: quoted && { seq: quoted.seq, authorName: quoted.authorName, excerpt: excerpt(quoted.text) },
    });
  }

  async function saveEdit(m: Message, text: string) {
    if (text === m.text) return;
    apply([{ ...m, text, editedAt: new Date().toISOString() }]);
    try {
      apply([await live.request("edit", { roomId, chatId, seq: m.seq, text }) as Message]);
    } catch (e) {
      apply([m]);
      toast(errorText(e), "error");
    }
  }

  const actions = useMemo<RowActions>(() => ({
    async react(m: Message, reaction: Reaction, on: boolean) {
      const users = (m.reactions[reaction] ?? []).filter((u) => u !== me.userId);
      apply([{ ...m, reactions: { ...m.reactions, [reaction]: on ? [...users, me.userId] : users } }]);
      try {
        apply([await live.request("react", { roomId, chatId, seq: m.seq, reaction, on }) as Message]);
      } catch (e) {
        apply([m]);
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
    retry(clientId: string) {
      const failed = latest.current.pending.find((p) => p.clientId === clientId);
      if (!failed) return;
      setTimeline((t) => dropPending(t, clientId));
      queue({ text: failed.text, attachments: failed.attachments, replyTo: failed.replyTo });
    },
    discard: (clientId: string) => setTimeline((t) => dropPending(t, clientId)),
  }), [me.userId, live, roomId, chatId, apply, toast, jumpTo, queue]);

  const ctx = useMemo<RowContext>(
    () => ({ meId: me.userId, role, members, now, timeZone, readOnly: archived }),
    [me.userId, role, members, now, timeZone, archived],
  );

  const rows = useMemo<Row[]>(() => [
    ...timeline.messages.map((m) => ({ key: keyOf(m), message: m })),
    ...timeline.pending.map((p): Row => ({
      key: keyOf(p),
      status: p.failed ? "failed" : "pending",
      message: {
        roomId, chatId, seq: 0, authorId: me.userId, authorName: me.username, clientId: p.clientId, text: p.text,
        createdAt: p.createdAt, replyTo: p.replyTo, attachments: p.attachments, reactions: {}, mentions: [], everyone: false,
      },
    })),
  ], [timeline, roomId, chatId, me]);

  const newest = newestSeq(timeline);
  useEffect(() => {
    if (!pinned || hasNewer || !visible || newest <= lastRead.current) return;
    const timer = setTimeout(() => {
      live.request("read", { roomId, chatId, seq: newest })
        .then(() => { lastRead.current = Math.max(lastRead.current, newest); }, () => {});
    }, READ_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [pinned, hasNewer, visible, newest, live, roomId, chatId]);

  const onPinnedChange = useCallback((isPinned: boolean) => {
    setPinned(isPinned);
    if (isPinned && !hasNewer) setUnseen(0);
  }, [hasNewer]);

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
        rows={rows} ctx={ctx} actions={actions} fresh={fresh}
        editingKey={mode?.kind === "edit" ? keyOf(mode.message) : undefined}
        hasOlder={hasOlder} hasNewer={hasNewer} loadingOlder={loadingOlder} jump={jump} unseen={unseen}
        onLoadOlder={loadOlder} onLoadNewer={loadNewer} onPinnedChange={onPinnedChange} onShowLatest={showLatest}
        intro={<ChatIntro chatName={chatName} roomName={roomName} />}
      />
      <TypingLine roomId={roomId} chatId={chatId} meId={me.userId} />
      {archived
        ? (
          <div className="mx-auto w-full max-w-[836px] px-4 pb-5 sm:px-7">
            <div className="flex h-[54px] items-center gap-2.5 rounded-2xl border border-line bg-surface-1 px-[18px] text-[13.5px] text-text-3">
              <Archive aria-hidden="true" size={15} />
              This room is archived.
            </div>
          </div>
        )
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
