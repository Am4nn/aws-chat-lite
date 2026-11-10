"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { bff } from "@/lib/client/bff";
import { isPaletteShortcut } from "@/lib/keys";
import { enterFrom } from "@/lib/motion";
import { isAdmin, type Me, type RoomSummary, type RoomView } from "@/lib/types";
import { CommandPalette, type PaletteItem } from "@/components/overlays/CommandPalette";
import { Modal } from "@/components/overlays/Modal";
import { ToastProvider } from "@/components/overlays/Toast";
import { CreateChat } from "@/components/rooms/CreateChat";
import { CreateRoom } from "@/components/rooms/CreateRoom";
import { MemberList } from "@/components/rooms/MemberList";
import { Header } from "./Header";
import { Panel } from "./Panel";
import { Sidebar } from "./Sidebar";
import { direction, navIndex } from "./nav";

type Dialog = "chat" | "room" | null;

export function RoomShell({ view, rooms, me, children }: { view: RoomView; rooms: RoomSummary[]; me: Me; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { chatId } = useParams<{ chatId?: string }>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  const chatItems = view.chats.map((c) => ({ id: c.chatId }));
  const index = navIndex(chatItems, chatId ?? "");
  const prevIndex = useRef(index);
  const dir = direction(prevIndex.current, index);
  useEffect(() => { prevIndex.current = index; }, [index]);

  // Chats that appear after the page loaded (just created) get a one-time entrance in the sidebar.
  const initialChats = useRef(new Set(view.chats.map((c) => c.chatId)));
  const newChatIds = new Set(view.chats.map((c) => c.chatId).filter((id) => !initialChats.current.has(id)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function signOut() {
    await bff("/bff/auth/signout", { body: {} });
    router.replace("/login");
  }

  const paletteItems: PaletteItem[] = [
    ...view.chats.map((c) => ({ id: `chat-${c.chatId}`, group: "Chats", label: `#${c.name}`, icon: "#", run: () => router.push(`/r/${view.room.roomId}/c/${c.chatId}`) })),
    ...rooms.filter((r) => r.roomId !== view.room.roomId)
      .map((r) => ({ id: `room-${r.roomId}`, group: "Rooms", label: r.name, icon: r.name.slice(0, 1).toUpperCase(), run: () => router.push(`/r/${r.roomId}`) })),
    ...(isAdmin(view.me.role) ? [{ id: "new-chat", group: "Actions", label: "New chat…", icon: "+", run: () => setDialog("chat") }] : []),
    ...(me.isCreator ? [{ id: "new-room", group: "Actions", label: "New room…", icon: "+", run: () => setDialog("room") }] : []),
    { id: "panel", group: "Actions", label: "Toggle room panel", icon: "⇥", run: () => setPanelOpen((o) => !o) },
    { id: "signout", group: "Actions", label: "Sign out", icon: "↩", run: signOut },
  ];

  const activeChat = view.chats.find((c) => c.chatId === chatId);

  return (
    <ToastProvider>
      <div className="flex h-dvh overflow-hidden bg-ink">
        <Sidebar
          view={view} rooms={rooms} me={me} activeChatId={chatId} newChatIds={newChatIds}
          onPalette={() => setPaletteOpen(true)} onNewChat={() => setDialog("chat")} onNewRoom={() => setDialog("room")} onSignOut={signOut}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <Header roomName={view.room.name} chatName={activeChat?.name} members={view.members} onTogglePanel={() => setPanelOpen((o) => !o)} />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={pathname} {...enterFrom(dir)} exit={{ opacity: 0 }} className="absolute inset-0">
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
        <Panel open={panelOpen} tabs={[{ id: "members", label: `Members · ${view.members.length}`, content: <MemberList members={view.members} /> }]} />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />
      <Modal open={dialog === "chat"} onClose={() => setDialog(null)} title="New chat">
        <CreateChat roomId={view.room.roomId} onDone={() => setDialog(null)} />
      </Modal>
      <Modal open={dialog === "room"} onClose={() => setDialog(null)} title="New room">
        <CreateRoom onDone={() => setDialog(null)} />
      </Modal>
    </ToastProvider>
  );
}
