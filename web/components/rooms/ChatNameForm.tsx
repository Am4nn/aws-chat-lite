"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { bff } from "@/lib/client/bff";
import type { Chat } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";

/** Shows the name as the server will store it (lowercase, dashes) while you type. */
const preview = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

type Named = Pick<Chat, "chatId" | "name">;

/** A new chat's name, which opens it once made, or a new name for `chat`, which stays where you are. */
export function ChatNameForm({ roomId, chat, onDone }: { roomId: string; chat?: Named; onDone: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(chat?.name ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { name: preview(name) };
      if (chat) {
        const renamed = await bff<Named>(`/bff/api/rooms/${roomId}/chats/${chat.chatId}`, { method: "PATCH", body });
        toast(`Renamed to #${renamed.name}`);
        onDone();
      } else {
        const created = await bff<Named>(`/bff/api/rooms/${roomId}/chats`, { body });
        toast(`#${created.name} created`);
        onDone();
        router.push(`/r/${roomId}/c/${created.chatId}`);
      }
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
      {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || preview(name) === chat?.name}>
          {busy && <Spinner />}{chat ? "Rename" : "Create chat"}
        </Button>
      </div>
    </form>
  );
}
