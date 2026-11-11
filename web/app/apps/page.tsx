import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { serverApi } from "@/lib/server/api";
import type { McpApp } from "@/lib/types";
import { AppsList } from "./AppsList";

/** The MCP apps (Claude Code and the like) the user has let into their rooms, each removable at once. */
export default async function AppsPage() {
  const { apps } = await serverApi<{ apps: McpApp[] }>("/me/apps");
  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 py-10">
      <div className="w-full max-w-[440px] rounded-2xl border border-line-strong bg-surface-2 p-6">
        <div className="flex items-center gap-1.5">
          <Link
            href="/"
            aria-label="Go to your rooms"
            className="-ml-2 grid size-8 place-items-center rounded-lg text-text-3 transition-[background-color,color,transform] hover:bg-surface-3 hover:text-text active:scale-90"
          >
            <ArrowLeft aria-hidden="true" size={16} />
          </Link>
          <h1 className="font-display text-xl font-bold">Connected apps</h1>
        </div>
        <AppsList initial={apps} />
      </div>
    </main>
  );
}
