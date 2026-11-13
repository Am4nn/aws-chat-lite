"use client";

import { Copy } from "lucide-react";
import { useToast } from "@/components/overlays/Toast";

/** How to let an MCP client in: one command, and the consent page's sign-in puts it in the list above. */
export function ConnectClient({ command }: { command: string }) {
  const toast = useToast();
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    toast("Command copied");
  };

  return (
    <section className="mt-8 rounded-xl border border-line-strong bg-surface-1 p-4">
      <h2 className="text-[13.5px] font-semibold">Connect a client</h2>
      <p className="mt-1 text-[13px] text-text-2">Any MCP client can read and post in your rooms through chat-lite&apos;s MCP server.</p>
      <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-line bg-surface-2 py-2 pl-3 pr-1.5">
        <code className="min-w-0 flex-1 break-all py-1 font-mono text-[12px] leading-5 text-text">{command}</code>
        <button
          onClick={copy}
          aria-label="Copy command"
          title="Copy command"
          className="grid size-7 shrink-0 place-items-center rounded-lg text-text-3 transition-[background-color,color,scale] hover:bg-surface-3 hover:text-text active:scale-90"
        >
          <Copy aria-hidden="true" size={14} />
        </button>
      </div>
      <p className="mt-2 text-[12.5px] text-text-3">Signing in on the consent page adds it to this list.</p>
    </section>
  );
}
