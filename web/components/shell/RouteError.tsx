"use client";

import { useEffect, useRef } from "react";
import { CircleAlert, WifiOff } from "lucide-react";
import { useOnline } from "@/lib/client/useOnline";
import { Button } from "@/components/ui/Button";

/**
 * The body of every error boundary: the page didn't load, nothing changed, try again. The error's own text is never
 * shown (it is the server's or a library's); the digest lets a report be matched to the server's log.
 */
export function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const online = useOnline();
  // A page that failed while offline loads again by itself once the connection is back.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!online) wasOffline.current = true;
    else if (wasOffline.current) {
      wasOffline.current = false;
      retry();
    }
  }, [online, retry]);

  return (
    <div role="alert" className={`flex w-full max-w-[380px] flex-col gap-4 rounded-2xl border bg-surface-2 p-5 ${online ? "border-danger-line" : "border-line-strong"}`}>
      <p className="flex items-start gap-2.5 text-[13.5px] leading-snug text-text">
        {online
          ? <CircleAlert aria-hidden="true" size={16} className="mt-px shrink-0 text-danger" />
          : <WifiOff aria-hidden="true" size={16} className="mt-px shrink-0 text-text-3" />}
        {online ? "This didn't load. Nothing was changed." : "You're offline. This will load when you're back online."}
      </p>
      {online && (
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={retry}>Try again</Button>
          {error.digest && <span className="min-w-0 truncate font-mono text-[11.5px] text-text-3">Ref {error.digest}</span>}
        </div>
      )}
    </div>
  );
}
