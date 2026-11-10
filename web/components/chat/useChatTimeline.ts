"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bff, errorText } from "@/lib/client/bff";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import { applyMessages, newestSeq, type Timeline } from "@/lib/client/timeline";
import type { Message } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import type { Jump } from "./MessageList";

const PAGE = 50;

/** Rows keep one identity from pending to stored, so a sent message doesn't re-enter when its ack lands. */
export const keyOf = (m: { clientId?: string; seq?: number }) => (m.clientId ? `c:${m.clientId}` : `s:${m.seq}`);

const startsAtFirst = (messages: Message[]) => (messages[0]?.seq ?? 1) <= 1;

/**
 * One chat's messages: history from the API, live changes from the socket. The timeline normally runs from some older
 * page to the newest message. A jump to an old quote can replace it with a page in the middle ("detached",
 * `hasNewer`), and scrolling down then pages forward until it meets the present again.
 */
export function useChatTimeline({ roomId, chatId, meId, initial }: { roomId: string; chatId: string; meId: string; initial: Message[] }) {
  const toast = useToast();
  const api = `/bff/api/rooms/${roomId}/chats/${chatId}/messages`;
  const [timeline, setTimeline] = useState<Timeline>({ messages: initial, pending: [] });
  const [fresh, setFresh] = useState(() => new Set<string>());
  const [hasOlder, setHasOlder] = useState(!startsAtFirst(initial));
  const [hasNewer, setHasNewer] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [jump, setJump] = useState<Jump | null>(null);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  // Async paging reads the timeline through this, so the callbacks stay stable while messages stream in.
  const latest = useRef(timeline);
  useEffect(() => { latest.current = timeline; });
  const paging = useRef(false);

  const markFresh = useCallback((keys: string[]) => setFresh((s) => new Set([...s, ...keys])), []);
  const apply = useCallback((messages: Message[]) => setTimeline((t) => applyMessages(t, messages)), []);
  const page = useCallback(async (query: string) => (await bff<{ messages: Message[] }>(`${api}${query}`)).messages, [api]);
  const scrollToBottom = useCallback(() => setJump({ to: "bottom", n: Date.now() }), []);

  /** Fetches forward from `after` until a short page says there is nothing newer. */
  const catchUp = useCallback(async (after: number) => {
    for (let seq = after; ;) {
      const messages = await page(`?after=${seq}`);
      markFresh(messages.map(keyOf));
      apply(messages);
      if (messages.length < PAGE) return;
      seq = messages.at(-1)!.seq;
    }
  }, [apply, markFresh, page]);

  useLiveEvent("message.new", ({ message: m }) => {
    if (m.chatId !== chatId) return;
    if (m.authorId !== meId && (!pinned || hasNewer)) setUnseen((n) => n + 1);
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

  /** A failure stops automatic paging (which would retry in a loop on a short chat) until the user asks again. */
  const loadOlder = useCallback(async () => {
    const oldest = latest.current.messages[0]?.seq;
    if (paging.current || !oldest) return;
    paging.current = true;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const messages = await page(`?before=${oldest}`);
      apply(messages);
      setHasOlder(!startsAtFirst(messages));
    } catch (e) {
      setOlderFailed(true);
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
        setHasOlder(!startsAtFirst(messages));
        setHasNewer(false);
      } catch (e) {
        return toast(errorText(e), "error");
      }
    }
    scrollToBottom();
  }, [hasNewer, page, toast, scrollToBottom]);

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
        setHasOlder(!startsAtFirst(messages));
      } catch (e) {
        return toast(errorText(e), "error");
      }
    }
    setJump({ to: seq, n: Date.now() });
  }, [page, apply, toast]);

  const onPinnedChange = useCallback((isPinned: boolean) => {
    setPinned(isPinned);
    if (isPinned && !hasNewer) setUnseen(0);
  }, [hasNewer]);

  return {
    timeline, setTimeline, latest, apply, fresh, markFresh,
    hasOlder, hasNewer, loadingOlder, olderFailed, loadOlder, loadNewer, showLatest,
    jump, jumpTo, scrollToBottom, pinned, onPinnedChange, unseen,
  };
}
