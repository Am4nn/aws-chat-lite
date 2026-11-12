import type { ReactNode } from "react";
import { ChevronRight, Hash, Lock, Menu, PanelRight, Search } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { taintHint } from "@/lib/client/models";
import type { Member, TaintSource } from "@/lib/types";

const STACK = 4;

/**
 * `thread`: on a thread page, its title and run status in place of a chat's name. `taint`: what made that thread private.
 * `panelOpen`: whether the room panel shows. The sidebar button needs no such state: while the drawer is open, the
 * header is inert.
 */
export function Header({ roomName, chatName, thread, taint = [], members, panelOpen, navCollapsed, onMenu, onSearch, onTogglePanel }: {
  roomName: string; chatName?: string; thread?: ReactNode; taint?: TaintSource[]; members: Member[]; panelOpen: boolean;
  /** The reader hid the sidebar, so its button shows on a wide screen too. */
  navCollapsed: boolean;
  onMenu: () => void; onSearch: () => void; onTogglePanel: () => void;
}) {
  // Whoever is online leads the stack, so presence is visible even in a big room.
  const stack = [...members].sort((a, b) => Number(b.online) - Number(a.online)).slice(0, STACK);
  const online = members.filter((m) => m.online).length;

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-3 md:px-5">
      <HeaderButton label="Open sidebar" onClick={onMenu} className={navCollapsed ? "" : "md:hidden"}><Menu aria-hidden="true" size={16} /></HeaderButton>
      <span className="truncate text-[13px] text-text-3 max-md:hidden">{roomName}</span>
      {(chatName || thread) && <ChevronRight aria-hidden="true" size={13} className="shrink-0 text-line-hover max-md:hidden" />}
      {chatName && (
        <h1 className="flex min-w-0 items-center gap-1 text-[15px] font-semibold">
          <Hash aria-hidden="true" size={16} className="shrink-0 text-text-3" />
          <span className="truncate">{chatName}</span>
        </h1>
      )}
      {thread}
      {taint.length > 0 && (
        <span role="img" aria-label={taintHint(taint)} title={taintHint(taint)} className="shrink-0 text-text-3">
          <Lock aria-hidden="true" size={14} />
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span role="img" className="mr-1 flex -space-x-2 max-sm:hidden" aria-label={`${members.length} members, ${online} online`}>
          {/* Each avatar sits above the next, so the online dot in its corner is never covered. */}
          {stack.map((m, i) => <span key={m.userId} className="relative flex" style={{ zIndex: STACK - i }}><Avatar name={m.username} online={m.online} ring /></span>)}
        </span>
        <HeaderButton label="Search messages" onClick={onSearch}><Search aria-hidden="true" size={15} /></HeaderButton>
        <HeaderButton label="Toggle room panel" pressed={panelOpen} onClick={onTogglePanel}><PanelRight aria-hidden="true" size={15} /></HeaderButton>
      </div>
    </header>
  );
}

function HeaderButton({ label, pressed, onClick, className = "", children }: {
  label: string; pressed?: boolean; onClick: () => void; className?: string; children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`grid size-8 shrink-0 place-items-center rounded-[10px] border border-line-strong bg-surface-2 text-text-2 transition-[border-color,color,scale] hover:border-line-hover hover:text-text active:scale-[0.94] ${className}`}
    >
      {children}
    </button>
  );
}
