"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { bff, BffError, errorText } from "@/lib/client/bff";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

type Decision = "allow" | "deny";

export function ConsentActions({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState("");

  async function decide(decision: Decision) {
    setBusy(decision);
    setError("");
    try {
      const { redirectTo } = await bff<{ redirectTo: string }>(`/bff/api/oauth/requests/${encodeURIComponent(requestId)}/decision`, { body: { decision } });
      location.assign(redirectTo);
    } catch (e) {
      // A request is answered once and expires; once it's gone, the page's own read of it shows the expired copy.
      if (e instanceof BffError && e.status === 404) {
        router.refresh();
      } else {
        setError(errorText(e));
        setBusy(null);
      }
    }
  }

  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-2">
        <Button onClick={() => decide("deny")} disabled={!!busy} className="h-11">{busy === "deny" && <Spinner />}Cancel</Button>
        <Button variant="primary" onClick={() => decide("allow")} disabled={!!busy} className="h-11">{busy === "allow" && <Spinner />}Allow</Button>
      </div>
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </>
  );
}
