"use client";

import { useLiveEvent } from "@/lib/client/LiveProvider";
import { playMentionTick } from "@/lib/client/sound";

/** The one sound in the app: someone else @mentions me or @everyone, in any chat, while the tab is open. */
export function MentionSound({ meId }: { meId: string }) {
  useLiveEvent("message.new", ({ message: m }) => {
    if (m.authorId !== meId && (m.everyone || m.mentions.includes(meId))) playMentionTick();
  });
  return null;
}
