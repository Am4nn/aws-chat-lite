import { useCallback, useEffect } from "react";
import { errorText } from "@/lib/client/bff";
import { useLive } from "@/lib/client/LiveProvider";
import { addPending, dropPending, failPending, keyOf, type PendingMessage } from "@/lib/client/timeline";
import type { Attachment, Message } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import type { useChatTimeline } from "./useChatTimeline";

type Draft = Omit<PendingMessage, "clientId" | "createdAt">;
type Timeline = Pick<ReturnType<typeof useChatTimeline>, "latest" | "setTimeline" | "apply" | "markFresh">;

const revokePreviews = (attachments: Attachment[]) =>
  attachments.forEach((a) => a.url?.startsWith("blob:") && URL.revokeObjectURL(a.url));

/**
 * My messages on their way: each shows at once as pending, then becomes the stored message the server acks, or stays
 * as "not sent" with Retry and Discard. Sends aren't idempotent, so a failure is left to the user: an automatic resend
 * could post twice.
 */
export function useOutbox({ roomId, chatId, chat, toBottom }: { roomId: string; chatId: string; chat: Timeline; toBottom: () => void }) {
  const live = useLive();
  const toast = useToast();
  const { latest, setTimeline, apply, markFresh } = chat;

  useEffect(() => () => latest.current.pending.forEach((p) => revokePreviews(p.attachments)), [latest]);

  const deliver = useCallback(async (p: PendingMessage) => {
    try {
      const message = await live.request("send", {
        roomId, chatId, clientId: p.clientId, text: p.text, replyToSeq: p.replyTo?.seq, threadId: p.threadId, model: p.model,
        attachments: p.attachments.map(({ key, name, size, type }) => ({ key, name, size, type })),
      }) as Message;
      apply([message]);
      revokePreviews(p.attachments);
    } catch (e) {
      setTimeline((t) => failPending(t, p.clientId));
      toast(errorText(e), "error");
    }
  }, [live, roomId, chatId, apply, setTimeline, toast]);

  const queue = useCallback((draft: Draft) => {
    const pending = { ...draft, clientId: crypto.randomUUID(), createdAt: new Date().toISOString() };
    markFresh([keyOf(pending)]);
    setTimeline((t) => addPending(t, pending));
    toBottom();
    void deliver(pending);
  }, [deliver, markFresh, setTimeline, toBottom]);

  const retry = useCallback((clientId: string) => {
    const failed = latest.current.pending.find((p) => p.clientId === clientId);
    if (!failed) return;
    setTimeline((t) => dropPending(t, clientId));
    queue({ text: failed.text, attachments: failed.attachments, replyTo: failed.replyTo, threadId: failed.threadId, model: failed.model });
  }, [latest, setTimeline, queue]);

  const discard = useCallback((clientId: string) => {
    const failed = latest.current.pending.find((p) => p.clientId === clientId);
    if (failed) revokePreviews(failed.attachments);
    setTimeline((t) => dropPending(t, clientId));
  }, [latest, setTimeline]);

  return { queue, retry, discard };
}
