"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { MoreHorizontal } from "lucide-react";
import { bff } from "@/lib/client/bff";
import { useClickOutside } from "@/lib/client/useClickOutside";
import { dur, easeOut, spring } from "@/lib/motion";
import type { Member, Role } from "@/lib/types";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/overlays/Toast";

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

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
  const sorted = [...members].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.username.localeCompare(b.username));

  async function change(m: Member, action: "promote" | "demote" | "remove") {
    setOpenFor(null);
    if (action === "remove") {
      await bff(`/bff/api/rooms/${roomId}/members/${m.userId}`, { method: "DELETE", body: {} });
      toast(`${m.username} removed`);
    } else {
      const role = action === "promote" ? "admin" : "member";
      await bff(`/bff/api/rooms/${roomId}/members/${m.userId}`, { method: "PATCH", body: { role } });
      toast(`${m.username} is now ${role === "admin" ? "an admin" : "a member"}`);
    }
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
              <Avatar name={m.username} />
              <span className="truncate">{m.username}{m.userId === myUserId && <span className="text-text-3"> (you)</span>}</span>
              <span className="ml-auto"><RoleBadge role={m.role} /></span>
              {hasActions && (
                <MemberMenu open={openFor === m.userId} onToggle={(o) => setOpenFor(o ? m.userId : null)} name={m.username}>
                  {can.promote && <MenuItem onClick={() => change(m, "promote")}>Make admin</MenuItem>}
                  {can.demote && <MenuItem onClick={() => change(m, "demote")}>Make member</MenuItem>}
                  {can.remove && <MenuItem danger onClick={() => change(m, "remove")}>Remove from room</MenuItem>}
                </MemberMenu>
              )}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

function MemberMenu({ open, onToggle, name, children }: { open: boolean; onToggle: (open: boolean) => void; name: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => onToggle(false));

  return (
    <div ref={ref} className="relative">
      <button
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        className="grid size-7 place-items-center rounded-md text-text-3 transition-colors hover:bg-surface-3 hover:text-text"
      >
        <MoreHorizontal aria-hidden="true" size={15} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, transition: { duration: dur.fast } }}
            transition={{ duration: dur.fast, ease: easeOut }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-8 z-20 w-44 rounded-xl border border-line-strong bg-surface-2 p-1 shadow-[0_16px_40px_rgba(0,0,0,.5)]"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({ danger = false, onClick, children }: { danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[13px] transition-colors hover:bg-surface-3 ${danger ? "text-[#ff9b8f]" : "text-text-2 hover:text-text"}`}
    >
      {children}
    </button>
  );
}
