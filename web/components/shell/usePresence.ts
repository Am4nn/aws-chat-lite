"use client";

import { useMemo, useState } from "react";
import { useLiveEvent } from "@/lib/client/LiveProvider";
import type { Member } from "@/lib/types";

type Seen = Pick<Member, "online" | "lastSeen">;

/**
 * The room's members with presence kept live from the socket; a fresh room view starts from its own data again. I'm
 * always online in my own view: the view is fetched before my socket connects, and the server leaves a new socket
 * out of its own announcement.
 */
export function usePresence(members: Member[], meId: string): Member[] {
  const [source, setSource] = useState(members);
  const [live, setLive] = useState<Record<string, Seen>>({});
  if (source !== members) {
    setSource(members);
    setLive({});
  }
  useLiveEvent("presence", (e) => setLive((p) => ({ ...p, [e.userId]: { online: e.online, lastSeen: e.lastSeen } })));
  return useMemo(
    () => members.map((m) => (m.userId === meId ? { ...m, online: true } : live[m.userId] ? { ...m, ...live[m.userId] } : m)),
    [members, live, meId],
  );
}
