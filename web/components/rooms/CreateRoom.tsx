"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { bff } from "@/lib/client/bff";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";

export function CreateRoom({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const room = await bff<{ roomId: string; generalChatId: string }>("/bff/api/rooms", { body: { name } });
      onDone?.();
      router.push(`/r/${room.roomId}/c/${room.generalChatId}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 text-left">
      <Field id="room-name" label="Room name" placeholder="dev-team" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus />
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        {onDone && <Button type="button" onClick={onDone}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy && <Spinner />}Create room</Button>
      </div>
    </form>
  );
}
