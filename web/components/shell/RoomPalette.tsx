"use client";

import { useEffect } from "react";
import { Bot, Search } from "lucide-react";
import { bff, bffOrNull, errorText } from "@/lib/client/bff";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { isPaletteShortcut } from "@/lib/keys";
import type { Me, RoomSummary, RoomView, ThreadSummary } from "@/lib/types";
import { CommandPalette, type PaletteItem } from "@/components/overlays/CommandPalette";
import { useToast } from "@/components/overlays/Toast";
import { inviteUrl } from "@/components/rooms/invite";
import { useNavigate } from "./NavPending";
import type { Dialog } from "./RoomDialogs";

/** Ctrl K in a room: its threads, chats and the other rooms to jump to, and what I may do here. */
export function RoomPalette({ open, onOpenChange, view, rooms, me, admin, onSearch, onDialog, onTogglePanel, onSignOut }: {
  open: boolean; onOpenChange: (open: boolean) => void; view: RoomView; rooms: RoomSummary[]; me: Me; admin: boolean;
  onSearch: () => void; onDialog: (dialog: Dialog) => void; onTogglePanel: () => void; onSignOut: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const threads = useThreads();
  const { room } = view;
  const roomId = room.roomId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  /** Copies the room's live invite link, creating one first when there is none. */
  async function copyInvite() {
    const path = `/bff/api/rooms/${roomId}/invite`;
    try {
      const invite = (await bffOrNull<{ code: string }>(path)) ?? (await bff<{ code: string }>(path, { body: {} }));
      await navigator.clipboard.writeText(inviteUrl(window.location.origin, invite.code));
      toast("Invite link copied");
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  /** "@agent …": a new thread, opened once the server has numbered it. */
  async function askAgent(text: string) {
    try {
      const { thread } = await bff<{ thread: ThreadSummary }>(`/bff/api/rooms/${roomId}/threads`, { body: { text, clientId: crypto.randomUUID() } });
      threads.apply(thread);
      navigate(`/r/${roomId}/t/${thread.number}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const threadItem = (group: string) => (t: ThreadSummary): PaletteItem => ({
    id: `thread-${t.threadId}`, group, label: `#${t.number} ${t.name}`, icon: <Bot aria-hidden="true" size={13} />,
    run: () => navigate(`/r/${roomId}/t/${t.number}`),
  });
  const items: PaletteItem[] = [
    ...threads.threads.filter((t) => !t.archived).sort((a, b) => b.number - a.number).map(threadItem("Threads")),
    ...view.chats.filter((c) => !c.archived).map((c) => ({ id: `chat-${c.chatId}`, group: "Chats", label: `#${c.name}`, icon: "#", run: () => navigate(`/r/${roomId}/c/${c.chatId}`) })),
    ...rooms.filter((r) => r.roomId !== roomId)
      .map((r) => ({ id: `room-${r.roomId}`, group: "Rooms", label: r.name, icon: r.name.slice(0, 1).toUpperCase(), run: () => navigate(`/r/${r.roomId}`) })),
    ...(room.archived ? [] : [{ id: "new-thread", group: "Actions", label: "New thread", icon: "+", run: () => navigate(`/r/${roomId}/t/new`) }]),
    { id: "search", group: "Actions", label: "Search messages…", icon: <Search aria-hidden="true" size={13} />, run: onSearch },
    ...(admin ? [
      { id: "new-chat", group: "Actions", label: "New chat…", icon: "+", run: () => onDialog("chat") },
      { id: "copy-invite", group: "Actions", label: "Copy invite link", icon: "↗", run: copyInvite },
    ] : []),
    ...(me.isCreator ? [{ id: "new-room", group: "Actions", label: "New room…", icon: "+", run: () => onDialog("room") }] : []),
    { id: "panel", group: "Actions", label: "Toggle room panel", icon: "⇥", run: onTogglePanel },
    { id: "signout", group: "Actions", label: "Sign out", icon: "↩", run: onSignOut },
    // Still reachable: a message sent in an archived thread reopens it.
    ...threads.threads.filter((t) => t.archived).sort((a, b) => b.number - a.number).map(threadItem("Archived")),
  ];

  return (
    <CommandPalette
      open={open} onClose={() => onOpenChange(false)} items={items}
      agentNames={view.agents.map((a) => a.name)} onAsk={room.archived ? undefined : askAgent}
    />
  );
}
