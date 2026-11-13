import { headers } from "next/headers";
import { serverApi } from "@/lib/server/api";
import { serverEnv } from "@/lib/server/env";
import type { McpApp } from "@/lib/types";
import { AppsList } from "./AppsList";
import { ConnectClient } from "./ConnectClient";

/**
 * The site's public origin, which serves /mcp. Behind CloudFront the request's Host is the Function URL's, so the
 * configured origin comes first; `next dev` has none and is reached directly.
 */
async function siteOrigin() {
  const configured = serverEnv().siteOrigins[0];
  if (configured) return configured;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

/**
 * The MCP apps (Claude Code and the like) the user has let into their rooms, each removable at once. It belongs to the
 * account, not the room, but opens inside the room it was reached from so the sidebar stays.
 */
export default async function AppsPage() {
  const [{ apps }, origin] = await Promise.all([serverApi<{ apps: McpApp[] }>("/me/apps"), siteOrigin()]);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[640px] px-4 pb-10 pt-8 sm:px-7">
        <h1 className="font-display text-xl font-bold">Connected apps</h1>
        <AppsList initial={apps} />
        <ConnectClient command={`claude mcp add --transport http chat-lite ${origin}/mcp`} />
      </div>
    </div>
  );
}
