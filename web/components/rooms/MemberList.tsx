import { Avatar } from "@/components/ui/Avatar";
import type { Member, Role } from "@/lib/types";

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

export function RoleBadge({ role }: { role: Role }) {
  if (role === "member") return null;
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${role === "owner" ? "bg-[#172014] text-lime" : "bg-[#1a2023] text-text-2"}`}>
      {role}
    </span>
  );
}

export function MemberList({ members }: { members: Member[] }) {
  const sorted = [...members].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.username.localeCompare(b.username));
  return (
    <ul className="flex flex-col gap-1">
      {sorted.map((m) => (
        <li key={m.userId} className="flex h-10 items-center gap-2.5 rounded-[10px] px-2 text-[13px]">
          <Avatar name={m.username} />
          <span className="truncate">{m.username}</span>
          <span className="ml-auto"><RoleBadge role={m.role} /></span>
        </li>
      ))}
    </ul>
  );
}
