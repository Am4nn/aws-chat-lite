import { ChevronRight, Hash, PanelRight } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import type { Member } from "@/lib/types";

export function Header({ roomName, chatName, members, onTogglePanel }: {
  roomName: string; chatName?: string; members: Member[]; onTogglePanel: () => void;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line px-5">
      <span className="text-[13px] text-text-3">{roomName}</span>
      {chatName && (
        <>
          <ChevronRight aria-hidden="true" size={13} className="text-[#3e4749]" />
          <h1 className="flex items-center gap-1 font-display text-lg font-bold">
            <Hash aria-hidden="true" size={16} className="text-text-3" />
            {chatName}
          </h1>
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        <span className="mr-1 flex -space-x-2" aria-label={`${members.length} members`}>
          {members.slice(0, 4).map((m) => <Avatar key={m.userId} name={m.username} ring />)}
        </span>
        <button
          onClick={onTogglePanel}
          aria-label="Toggle room panel"
          className="grid size-8 place-items-center rounded-[10px] border border-line-strong bg-surface-2 text-text-2 transition-colors hover:border-[#36403f] hover:text-text"
        >
          <PanelRight aria-hidden="true" size={15} />
        </button>
      </div>
    </header>
  );
}
