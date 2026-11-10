"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { bff } from "@/lib/client/bff";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";

/** Shows the name as the server will store it (lowercase, dashes) while you type. */
const preview = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

export function CreateChat({ roomId, onDone }: { roomId: string; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const chat = await bff<{ chatId: string; name: string }>(`/bff/api/rooms/${roomId}/chats`, { body: { name: preview(name) } });
      toast(`#${chat.name} created`);
      onDone();
      router.push(`/r/${roomId}/c/${chat.chatId}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field id="chat-name" label="Name" placeholder="deploys" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required autoFocus />
      <p className="-mt-2 h-4 font-mono text-xs text-text-3">{name && `#${preview(name)}`}</p>
      {error && <p role="alert" className="text-[13px] text-[#ff9b8f]">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy && <Spinner />}Create chat</Button>
      </div>
    </form>
  );
}
