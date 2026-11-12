import { useEffect, useEffectEvent, useState } from "react";
import { useSearchParams } from "next/navigation";
import { takeFlowMark } from "@/lib/client/flow-return";
import { useToast } from "@/components/overlays/Toast";

/**
 * Connecting an MCP server or signing in with GitHub comes back to the room with the result in the address. It is
 * shown once (a toast, or the repo picker after GitHub) and only in the tab that started it, then dropped from the
 * address so a reload doesn't show it again. `onReturn` opens the panel tab the result belongs to.
 */
export function useFlowReturn(onReturn: () => void) {
  const toast = useToast();
  const query = useSearchParams();
  const mcpName = query.get("mcp");
  const error = query.get("mcpError") ?? query.get("githubError");
  const githubPick = query.get("github") === "pick";
  const [pickGitHub, setPickGitHub] = useState(false);
  const returned = useEffectEvent(onReturn);

  useEffect(() => {
    if (!mcpName && !error && !githubPick) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (!takeFlowMark()) return;
    if (githubPick) setPickGitHub(true);
    else toast(error ?? `Connected ${mcpName}`, error ? "error" : "done");
    returned();
  }, [mcpName, error, githubPick, toast]);

  return { pickGitHub, clearPick: () => setPickGitHub(false) };
}
