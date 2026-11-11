"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Search } from "lucide-react";
import { bff, bffOrNull, errorText } from "@/lib/client/bff";
import { useLive, useLiveStatus } from "@/lib/client/LiveProvider";
import { PHONE_QUERY, useIsPhone } from "@/lib/client/useIsPhone";
import { isPaletteShortcut } from "@/lib/keys";
import { enterFrom } from "@/lib/motion";
import { isAdmin, type Chat, type Me, type RoomSummary, type RoomView } from "@/lib/types";
import { CommandPalette, type PaletteItem } from "@/components/overlays/CommandPalette";
import { Confirm } from "@/components/overlays/Confirm";
import { Modal } from "@/components/overlays/Modal";
import { useToast } from "@/components/overlays/Toast";
import { CreateChat } from "@/components/rooms/CreateChat";
import { CreateRoom } from "@/components/rooms/CreateRoom";
import { MemberList } from "@/components/rooms/MemberList";
import { InvitePanel } from "@/components/rooms/InvitePanel";
import { inviteUrl } from "@/components/rooms/invite";
import { MentionSound } from "@/components/chat/MentionSound";
import { SearchPanel } from "@/components/chat/SearchPanel";
import { Header } from "./Header";
import { Backdrop, MobileNav } from "./MobileNav";
import { Panel } from "./Panel";
import { RoomSwitcher } from "./RoomSwitcher";
import { Sidebar } from "./Sidebar";
import { direction } from "./nav";
import { useBadges } from "./useBadges";
import { usePresence } from "./usePresence";
import { useRoomExit } from "./useRoomExit";

type Dialog = "chat" | "room" | "leave" | "archive" | null;
/** What covers the chat on a phone: the sidebar drawer or the room panel. */
type Overlay = "nav" | "panel" | null;

const isPhoneNow = () => window.matchMedia(PHONE_QUERY).matches;

export function RoomShell({ view, rooms, me, serverTimeZone, children }: {
  view: RoomView; rooms: RoomSummary[]; me: Me; serverTimeZone: string; children: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const reducedMotion = useReducedMotion() ?? false;
  const pathname = usePathname();
  const phone = useIsPhone();
  const { chatId } = useParams<{ chatId?: string }>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [panelTab, setPanelTab] = useState("members");
  const [searchFocus, setSearchFocus] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const live = useLive();
  const status = useLiveStatus();
  const { room } = view;
  const roomId = room.roomId;
  const badges = useBadges({ view, rooms, meId: me.userId, activeChatId: chatId });
  const members = usePresence(view.members, me.userId);
  const exitRoom = useRoomExit({ roomId, rooms, onExited: () => setDialog(null) });

  // The socket outlives room switches and subscribes only to the rooms the user was in when it connected, so each
  // room asks for its own events once the socket is open (again after every reconnect).
  useEffect(() => {
    if (status === "open") live.request("subscribe", { roomId }).catch(() => {});
  }, [live, status, roomId]);

  const index = view.chats.findIndex((c) => c.chatId === chatId);
  const prevIndex = useRef(index);
  const dir = direction(prevIndex.current, index);
  useEffect(() => { prevIndex.current = index; }, [index]);

  // Following a link out of the drawer or panel closes it.
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setOverlay(null);
  }

  // Chats that appear after the page loaded (just created) get a one-time entrance in the sidebar.
  const initialChats = useRef(new Set(view.chats.map((c) => c.chatId)));
  const newChatIds = new Set(view.chats.map((c) => c.chatId).filter((id) => !initialChats.current.has(id)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Something on top (a menu, a dialog, the @ list) that handled the Escape marked it, and keeps the drawer open.
      if (e.key === "Escape" && !e.defaultPrevented) setOverlay(null);
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      setPaletteOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function togglePanel() {
    if (isPhoneNow()) setOverlay((o) => (o === "panel" ? null : "panel"));
    else setPanelOpen((o) => !o);
  }

  function openSearch() {
    setPanelTab("search");
    setSearchFocus((n) => n + 1);
    if (isPhoneNow()) setOverlay("panel");
    else setPanelOpen(true);
  }

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

  async function signOut() {
    await bff("/bff/auth/signout", { body: {} });
    router.replace("/login");
  }

  /** Shown at once; a refusal puts it back. */
  async function mute(chat: Chat, muted: boolean) {
    badges.setMuted(chat.chatId, muted);
    try {
      await bff(`/bff/api/rooms/${roomId}/chats/${chat.chatId}/prefs`, { method: "PATCH", body: { muted } });
      toast(muted ? `#${chat.name} muted` : `#${chat.name} unmuted`);
    } catch (e) {
      badges.setMuted(chat.chatId, !muted);
      toast(errorText(e), "error");
    }
  }

  const paletteItems: PaletteItem[] = [
    ...view.chats.map((c) => ({ id: `chat-${c.chatId}`, group: "Chats", label: `#${c.name}`, icon: "#", run: () => router.push(`/r/${roomId}/c/${c.chatId}`) })),
    ...rooms.filter((r) => r.roomId !== roomId)
      .map((r) => ({ id: `room-${r.roomId}`, group: "Rooms", label: r.name, icon: r.name.slice(0, 1).toUpperCase(), run: () => router.push(`/r/${r.roomId}`) })),
    { id: "search", group: "Actions", label: "Search messages…", icon: <Search aria-hidden="true" size={13} />, run: openSearch },
    ...(isAdmin(view.me.role) ? [
      { id: "new-chat", group: "Actions", label: "New chat…", icon: "+", run: () => setDialog("chat") },
      { id: "copy-invite", group: "Actions", label: "Copy invite link", icon: "↗", run: copyInvite },
    ] : []),
    ...(me.isCreator ? [{ id: "new-room", group: "Actions", label: "New room…", icon: "+", run: () => setDialog("room") }] : []),
    { id: "panel", group: "Actions", label: "Toggle room panel", icon: "⇥", run: togglePanel },
    { id: "signout", group: "Actions", label: "Sign out", icon: "↩", run: signOut },
  ];

  const activeChat = view.chats.find((c) => c.chatId === chatId);
  const isOwner = view.me.role === "owner";

  return (
    <>
      <MentionSound meId={me.userId} />
      <div className="flex h-dvh overflow-hidden bg-ink">
        <MobileNav open={overlay === "nav"}>
          <Sidebar
            chats={badges.chats} me={me} roomId={roomId} canAddChat={isAdmin(view.me.role) && !room.archived}
            activeChatId={chatId} newChatIds={newChatIds}
            switcher={(
              <RoomSwitcher
                current={room} rooms={rooms} hasMentions={badges.hasMentions}
                canCreate={me.isCreator} canLeave={!isOwner} canArchive={isOwner && !room.archived}
                onCreate={() => setDialog("room")} onLeave={() => setDialog("leave")} onArchive={() => setDialog("archive")}
              />
            )}
            onPalette={() => setPaletteOpen(true)} onNewChat={() => setDialog("chat")} onMute={mute} onSignOut={signOut}
          />
        </MobileNav>
        <main inert={phone && overlay !== null} className="flex min-w-0 flex-1 flex-col">
          <Header
            roomName={room.name} chatName={activeChat?.name} members={members}
            onMenu={() => setOverlay("nav")} onSearch={openSearch} onTogglePanel={togglePanel}
          />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={pathname} {...enterFrom(dir, reducedMotion)} exit={{ opacity: 0 }} className="absolute inset-0">
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
        <Panel
          open={panelOpen}
          overlayOpen={overlay === "panel"}
          active={panelTab}
          onActiveChange={setPanelTab}
          tabs={[
            { id: "members", label: `Members · ${members.length}`, content: <MemberList roomId={roomId} members={members} myRole={view.me.role} myUserId={me.userId} /> },
            ...(isAdmin(view.me.role) && !room.archived ? [{ id: "invite", label: "Invite", content: <InvitePanel roomId={roomId} /> }] : []),
            { id: "search", label: "Search", content: <SearchPanel roomId={roomId} chats={view.chats} serverTimeZone={serverTimeZone} focusSignal={searchFocus} onPick={() => setOverlay(null)} /> },
          ]}
        />
        <Backdrop open={overlay !== null} onClose={() => setOverlay(null)} />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />
      <Modal open={dialog === "chat"} onClose={() => setDialog(null)} title="New chat">
        <CreateChat roomId={roomId} onDone={() => setDialog(null)} />
      </Modal>
      <Modal open={dialog === "room"} onClose={() => setDialog(null)} title="New room">
        <CreateRoom onDone={() => setDialog(null)} />
      </Modal>
      <Modal open={dialog === "leave"} onClose={() => setDialog(null)} title={`Leave ${room.name}?`}>
        <Confirm action="Leave room" onCancel={() => setDialog(null)} onConfirm={() => exitRoom("leave", `You left ${room.name}`)}>
          You&apos;ll stop seeing its chats. To come back you&apos;ll need a new invite link.
        </Confirm>
      </Modal>
      <Modal open={dialog === "archive"} onClose={() => setDialog(null)} title={`Archive ${room.name}?`}>
        <Confirm action="Archive room" onCancel={() => setDialog(null)} onConfirm={() => exitRoom("archive", `${room.name} archived`)}>
          The room becomes read-only and is hidden from everyone&apos;s room list. Its messages and files are kept, and its
          invite link stops working.
        </Confirm>
      </Modal>
    </>
  );
}
