import { Archive } from "lucide-react";
import { Hint } from "@/components/ui/Hint";

/** Where the composer would be, in a room or a chat that is read-only. */
export function ArchivedNotice({ chat = false }: { chat?: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[836px] px-4 pb-5 sm:px-7">
      <div className="flex h-[54px] items-center gap-2.5 rounded-2xl border border-line bg-surface-1 px-[18px] text-[13.5px] text-text-3">
        <Archive aria-hidden="true" size={15} />
        {chat ? "This chat is archived." : "This room is archived."}
        {chat && <Hint text="Read-only. Its messages stay here and in search; an admin can unarchive it from the sidebar." />}
      </div>
    </div>
  );
}
