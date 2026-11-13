import type { ReactNode } from "react";
import { ChevronRight, Hash, Lock, Menu, PanelRight } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { APPROVAL_MODES } from "@/lib/client/approval-mode";
import { isPrivate, taintHint } from "@/lib/client/models";
import type { ApprovalMode, Member, TaintSource } from "@/lib/types";

const STACK = 4;

/**
 * `thread`: on a thread page, its title and run status in place of a chat's name. `taint`: what made that thread private.
 * `approvalMode`: shown as a quiet pill unless it is Ask. `panelOpen`: whether the room panel shows. The avatar stack opens the panel's People tab; search lives in the panel. The sidebar button needs no such state: while the drawer is open, the
 * header is inert.
 */
export function Header({ roomName, chatName, thread, taint = [], approvalMode, members, panelOpen, navCollapsed, onMenu, onPeople, onTogglePanel }: {
  roomName: string; chatName?: string; thread?: ReactNode; taint?: TaintSource[]; approvalMode?: ApprovalMode; members: Member[]; panelOpen: boolean;
  /** The reader hid the sidebar, so its button shows on a wide screen too. */
  navCollapsed: boolean;
  onMenu: () => void; onPeople: () => void; onTogglePanel: () => void;
}) {
  // Whoever is online leads the stack, so presence is visible even in a big room.
  const stack = [...members].sort((a, b) => Number(b.online) - Number(a.online)).slice(0, STACK);
  const mode = approvalMode === "ask" ? undefined : APPROVAL_MODES.find((m) => m.mode === approvalMode);
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
      {isPrivate(taint) && (
        <span role="img" aria-label={taintHint(taint)} title={taintHint(taint)} className="shrink-0 text-text-3">
          <Lock aria-hidden="true" size={14} />
        </span>
      )}
      {mode && (
        <span role="img" aria-label={mode.title} title={mode.title} className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-text-2">
          {mode.label}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          onClick={onPeople}
          aria-label={`${members.length} members, ${online} online`}
          title="People"
          className="mr-1 flex -space-x-2 rounded-full transition-[scale,opacity] hover:opacity-85 active:scale-[0.96] max-sm:hidden"
        >
          {/* Each avatar sits above the next, so the online dot in its corner is never covered. */}
          {stack.map((m, i) => <span key={m.userId} className="relative flex" style={{ zIndex: STACK - i }}><Avatar name={m.username} online={m.online} ring /></span>)}
        </button>
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
