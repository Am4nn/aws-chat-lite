"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { bff, errorText } from "@/lib/client/bff";
import { timeAgo } from "@/lib/client/format";
import { dur, easeOut, spring } from "@/lib/motion";
import type { Member, Role } from "@/lib/types";
import { Avatar } from "@/components/ui/Avatar";
import { MenuItem, RowMenu } from "@/components/ui/RowMenu";
import { useToast } from "@/components/overlays/Toast";

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };
const CLOCK_TICK_MS = 60_000;

function RoleBadge({ role }: { role: Role }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      {role !== "member" && (
        <motion.span
          key={role}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={spring.pop}
          className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${role === "owner" ? "bg-[#172014] text-lime" : "bg-[#1a2023] text-text-2"}`}
        >
          {role}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** What I may do to this member. Mirrors the server's rules, which remain the real check. */
function actionsFor(me: Role, target: Role) {
  return {
    promote: me === "owner" && target === "member",
    demote: me === "owner" && target === "admin",
    remove: target !== "owner" && (me === "owner" || (me === "admin" && target === "member")),
  };
}

export function MemberList({ roomId, members, myRole, myUserId }: { roomId: string; members: Member[]; myRole: Role; myUserId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The server rendered "last seen" with its own clock, so the browser's takes over at once, then every minute.
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const sorted = [...members].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.username.localeCompare(b.username));

  async function change(m: Member, action: "promote" | "demote" | "remove") {
    setOpenFor(null);
    try {
      if (action === "remove") {
        await bff(`/bff/api/rooms/${roomId}/members/${m.userId}`, { method: "DELETE", body: {} });
        toast(`${m.username} removed`);
      } else {
        const role = action === "promote" ? "admin" : "member";
        await bff(`/bff/api/rooms/${roomId}/members/${m.userId}`, { method: "PATCH", body: { role } });
        toast(`${m.username} is now ${role === "admin" ? "an admin" : "a member"}`);
      }
    } catch (e) {
      toast(errorText(e), "error");
    }
    // Refresh either way: a failure usually means the member list changed underneath us.
    router.refresh();
  }

  return (
    <ul className="flex flex-col gap-1">
      <AnimatePresence initial={false}>
        {sorted.map((m) => {
          const can = actionsFor(myRole, m.role);
          const hasActions = m.userId !== myUserId && (can.promote || can.demote || can.remove);
          return (
            <motion.li
              key={m.userId}
              layout
              exit={{ opacity: 0, height: 0, transition: { duration: dur.base, ease: easeOut } }}
              transition={spring.glide}
              className="relative flex h-10 items-center gap-2.5 rounded-[10px] px-2 text-[13px] hover:bg-surface-2"
            >
              <Avatar name={m.username} online={m.online} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate leading-4">{m.username}{m.userId === myUserId && <span className="text-text-3"> (you)</span>}{m.online && <span className="sr-only">, online</span>}</span>
                {!m.online && m.lastSeen && (
                  <span suppressHydrationWarning className="truncate font-mono text-[11px] leading-4 text-text-3">last seen {timeAgo(m.lastSeen, now)}</span>
                )}
              </span>
              <span className="ml-auto"><RoleBadge role={m.role} /></span>
              {hasActions && (
                <RowMenu open={openFor === m.userId} onToggle={(o) => setOpenFor(o ? m.userId : null)} name={m.username}>
                  {can.promote && <MenuItem onClick={() => change(m, "promote")}>Make admin</MenuItem>}
                  {can.demote && <MenuItem onClick={() => change(m, "demote")}>Make member</MenuItem>}
                  {can.remove && <MenuItem danger onClick={() => change(m, "remove")}>Remove from room</MenuItem>}
                </RowMenu>
              )}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
