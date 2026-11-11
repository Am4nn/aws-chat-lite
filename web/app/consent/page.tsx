import { Check, ShieldAlert } from "lucide-react";
import { serverApi, serverApiOrNull } from "@/lib/server/api";
import { scopeLines } from "@/lib/client/apps";
import type { Me, Scope } from "@/lib/types";
import { ConsentActions } from "./ConsentActions";

type ConsentRequest = { clientName: string; redirectHost: string; scopes: Scope[] };

/** Where an MCP app's sign-in lands: the signed-in user lets the app into their rooms, or sends it away. */
export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ request?: string | string[] }> }) {
  const raw = (await searchParams).request;
  const id = typeof raw === "string" ? raw : "";
  const [me, request] = await Promise.all([
    serverApi<Me>("/me"),
    id ? serverApiOrNull<ConsentRequest>(`/oauth/requests/${encodeURIComponent(id)}`) : null,
  ]);

  return (
    <main className="grid min-h-dvh place-items-center bg-ink px-4 py-10">
      <div className="w-full max-w-[440px] rounded-2xl border border-line-strong bg-surface-2 p-6">
        {request ? (
          <>
            <h1 className="break-words font-display text-xl font-bold leading-snug">Allow {request.clientName} to use chat-lite?</h1>
            <p className="mt-1.5 text-[13px] text-text-2">Signed in as {me.username}.</p>
            <ul className="mt-5 flex flex-col gap-2.5">
              {scopeLines(request.scopes).map((line) => (
                <li key={line} className="flex items-start gap-2.5 text-[13.5px]">
                  <Check aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-text-3" />
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[13px] leading-relaxed text-text-2">It reaches only rooms you&apos;re in. You can remove it any time in Connected apps.</p>
            <p className="mt-2 text-[13px] leading-relaxed text-text-2">
              After you choose, you go back to <span className="break-all font-mono text-text">{request.redirectHost}</span>.
            </p>
            <p className="mt-4 flex gap-2.5 rounded-xl border border-line-strong bg-surface-1 p-3 text-[12.5px] leading-relaxed text-text-2">
              <ShieldAlert aria-hidden="true" size={15} className="mt-0.5 shrink-0 text-amber" />
              chat-lite hasn&apos;t checked who made this app. Allow it only if you started this from an app you trust.
            </p>
            <ConsentActions requestId={id} />
          </>
        ) : (
          <p className="text-sm text-text-2">This sign-in request expired. Start again from your app.</p>
        )}
      </div>
    </main>
  );
}
