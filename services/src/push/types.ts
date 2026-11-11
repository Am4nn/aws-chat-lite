import type { RunEndStatus } from "../threads/types.js";

/** What a browser's `PushManager.subscribe` gives: the push service's URL and the keys that encrypt for it. */
export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };
export type StoredSubscription = PushSubscriptionInput & { id: string; userId: string; createdAt: string };

/** Something to tell members about; `userIds` are the intended recipients, and an approval goes to the whole room. */
export type PushJob =
  | { kind: "mention"; roomId: string; chatId: string; seq: number; authorName: string; text: string; everyone: boolean; userIds: string[] }
  | {
    kind: "run"; roomId: string; threadId: string; number: number; status: RunEndStatus;
    summary?: string; reason?: string; stoppedBy?: string; userIds: string[];
  }
  | { kind: "approval"; roomId: string; threadId: string; number: number; runId: string; step: number; title: string };

/** The JSON a service worker receives and shows. */
export type PushNote = { title: string; body: string; url: string; tag: string; urgency: "normal" | "high" };
