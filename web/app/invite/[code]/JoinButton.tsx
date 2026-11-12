"use client";

import { useState } from "react";
import { bff, errorText } from "@/lib/client/bff";
import { Button } from "@/components/ui/Button";

export function JoinButton({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function join() {
    setBusy(true);
    setError("");
    try {
      const { roomId } = await bff<{ roomId: string }>(`/bff/api/invites/${code}/accept`, { body: {} });
      window.location.assign(`/r/${roomId}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={join} busy={busy} size="lg" className="w-full">Join room</Button>
      {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
    </>
  );
}
