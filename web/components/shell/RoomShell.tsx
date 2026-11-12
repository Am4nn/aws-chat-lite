"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { Activity, Bot, CalendarClock, Folder, NotebookPen, Plug, Search, UserPlus, Users, Workflow } from "lucide-react";
import { bff, errorText } from "@/lib/client/bff";
import { useLive, useLiveEvent, useLiveStatus } from "@/lib/client/LiveProvider";
import { ModelsProvider } from "@/lib/client/ModelsProvider";
import { signOut } from "@/lib/client/signOut";
import { sidebarThreads } from "@/lib/client/threads";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { useNow } from "@/lib/client/useNow";
import { useTimeZone } from "@/lib/client/useTimeZone";
import { saveNavCollapsed } from "@/lib/client/navCookie";
import { NARROW_QUERY, useIsNarrow, useIsPhone } from "@/lib/client/useIsPhone";
import { enterFrom } from "@/lib/motion";
import { isAdmin, type Chat, type Me, type RoomSummary, type RoomView } from "@/lib/types";
import { useToast } from "@/components/overlays/Toast";
import { AgentsPanel } from "@/components/rooms/AgentsPanel";
import { ConnectionsPanel } from "@/components/rooms/ConnectionsPanel";
import { InvitePanel } from "@/components/rooms/InvitePanel";
import { MemberList } from "@/components/rooms/MemberList";
import { MemoryPanel } from "@/components/rooms/MemoryPanel";
import { SchedulesPanel } from "@/components/rooms/SchedulesPanel";
import { MentionSound } from "@/components/chat/MentionSound";
import { FilesPanel } from "@/components/files/FilesPanel";
import { useRoomFiles } from "@/components/files/useRoomFiles";
import { SearchPanel } from "@/components/chat/SearchPanel";
import { StepDetails } from "@/components/threads/map/StepDetails";
import { StepPick, type PickedStep } from "@/components/threads/map/stepPick";
import { RunPanel } from "@/components/threads/RunPanel";
import { ThreadList } from "@/components/threads/ThreadList";
import { ThreadTitle } from "@/components/threads/ThreadTitle";
import { ViewSwitch } from "@/components/threads/ViewSwitch";
import { BudgetCard } from "./BudgetCard";
import { Header } from "./Header";
import { Backdrop, MobileNav } from "./MobileNav";
import { NeedsYouToast } from "./NeedsYouToast";
import { Panel } from "./Panel";
import { RoomDialogs, type Dialog } from "./RoomDialogs";
import { RoomPalette } from "./RoomPalette";
import { RoomSwitcher } from "./RoomSwitcher";
import { Sidebar } from "./Sidebar";
import { direction, navOrder } from "./nav";
import { useBadges } from "./useBadges";
import { useFlowReturn } from "./useFlowReturn";
import { usePresence } from "./usePresence";
import { usePush } from "./usePush";
import { useRoomExit } from "./useRoomExit";

/** What covers the chat: the sidebar drawer (on a phone) or the room panel (on a phone or a narrow window). */
type Overlay = "nav" | "panel" | null;

const isNarrowNow = () => window.matchMedia(NARROW_QUERY).matches;

export function RoomShell({ view, rooms, me, serverTimeZone, navHidden, children }: {
  view: RoomView; rooms: RoomSummary[]; me: Me; serverTimeZone: string; navHidden: boolean; children: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const reducedMotion = useReducedMotion() ?? false;
  const pathname = usePathname();
  const phone = useIsPhone();
  const narrow = useIsNarrow();
  const { chatId, number } = useParams<{ chatId?: string; number?: string }>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [navCollapsed, setNavCollapsed] = useState(navHidden);
  // An overlay left open counts only while the window is still narrow enough to show it as one.
  const covered = (overlay === "nav" && phone) || (overlay === "panel" && narrow);
  const [panelTab, setPanelTab] = useState(number ? "context" : "members");
  const [searchFocus, setSearchFocus] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [picked, setPicked] = useState<PickedStep | null>(null);
  const live = useLive();
  const status = useLiveStatus();
  const { room } = view;
  const roomId = room.roomId;
  const { archived } = room;
  const admin = isAdmin(view.me.role);
  const isOwner = view.me.role === "owner";
  const canManage = admin && !archived;
  const badges = useBadges({ view, rooms, meId: me.userId, activeChatId: chatId });
  const threads = useThreads();
  const timeZone = useTimeZone(serverTimeZone);
  const activeThread = number ? threads.byNumber(Number(number)) : undefined;
  const members = usePresence(view.members, me.userId);
  const files = useRoomFiles(roomId);
  const push = usePush();
  const exitRoom = useRoomExit({ roomId, rooms, onExited: () => setDialog(null) });
  const { pickGitHub, clearPick } = useFlowReturn(() => setPanelTab("connections"));
  const query = useSearchParams();
  const onMap = !!activeThread && query.get("view") === "map";
  // A step picked on another run's Map (another thread's, or this thread's before its next run) isn't shown.
  const shownStep = onMap && picked?.runId === (query.get("run") ?? activeThread.runId) ? picked : null;

  // The socket outlives room switches and subscribes only to the rooms the user was in when it connected, so each
  // room asks for its own events once the socket is open (again after every reconnect).
  useEffect(() => {
    if (status === "open") live.request("subscribe", { roomId }).catch(() => {});
  }, [live, status, roomId]);

  // Thread labels, the agent picker and the @ list read the agents from the room view, so a change fetches it again.
  useLiveEvent("agents.changed", (e) => {
    if (e.roomId === roomId) router.refresh();
  });

  // Read once: the order only needs to know which threads the sidebar lists, and that changes by days, not seconds.
  const loadedAt = useNow(false);
  const index = navOrder(sidebarThreads(threads.threads, loadedAt), view.chats).indexOf(chatId ?? activeThread?.threadId ?? "");
  const prevIndex = useRef(index);
  const dir = direction(prevIndex.current, index);
  useEffect(() => { prevIndex.current = index; }, [index]);

  // Following a link out of the drawer or panel closes it, and opening a thread shows its run in the panel.
  const [shownPath, setShownPath] = useState(pathname);
  const [navigated, setNavigated] = useState(false);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setNavigated(true);
    setOverlay(null);
    if (number) setPanelTab("context");
  }

  // Chats that appear after the page loaded (just created) get a one-time entrance in the sidebar.
  const initialChats = useRef(new Set(view.chats.map((c) => c.chatId)));
  const newChatIds = new Set(view.chats.map((c) => c.chatId).filter((id) => !initialChats.current.has(id)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Something on top (a menu, a dialog, the @ list) that handled the Escape marked it, and keeps the drawer open.
      if (e.key === "Escape" && !e.defaultPrevented) setOverlay(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function setNav(collapsed: boolean) {
    setNavCollapsed(collapsed);
    saveNavCollapsed(collapsed);
  }

  function togglePanel() {
    if (isNarrowNow()) setOverlay((o) => (o === "panel" ? null : "panel"));
    else setPanelOpen((o) => !o);
  }

  function showPanel(tab: string) {
    setPanelTab(tab);
    if (isNarrowNow()) setOverlay("panel");
    else setPanelOpen(true);
  }

  /** A step picked on the Map opens in the panel's Step tab. */
  function pickStep(step: PickedStep) {
    setPicked(step);
    showPanel("step");
  }

  function openSearch() {
    setSearchFocus((n) => n + 1);
    showPanel("search");
  }

  async function signOutToLogin() {
    await signOut();
    router.replace("/login");
  }

  /** The room hears it and refetches; this tab doesn't wait for that. An archived chat open here turns read-only. */
  async function setChatArchived(chat: Chat, archived: boolean) {
    try {
      await bff(`/bff/api/rooms/${roomId}/chats/${chat.chatId}`, { method: "PATCH", body: { archived } });
      toast(archived ? `#${chat.name} archived` : `#${chat.name} unarchived`);
      router.refresh();
    } catch (e) {
      toast(errorText(e), "error");
    }
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

  // Only the page that arrives animates. An exiting copy would re-render with the new route (the App Router doesn't
  // freeze a leaving segment), mounting the next page twice; and the page the room opened on is already in place.
  const enter = enterFrom(dir, reducedMotion);
  const activeChat = view.chats.find((c) => c.chatId === chatId);
  const meInRoom = { userId: me.userId, role: view.me.role };

  return (
    <ModelsProvider view={view}>
      <MentionSound meId={me.userId} />
      <NeedsYouToast roomId={roomId} openThreadId={activeThread?.threadId} panelOpen={panelOpen} />
      <div className="flex h-dvh overflow-hidden bg-ink">
        <MobileNav open={overlay === "nav"} collapsed={navCollapsed}>
          <Sidebar
            chats={badges.chats} me={me} roomId={roomId} canManage={canManage}
            activeChatId={chatId} newChatIds={newChatIds}
            threads={<ThreadList roomId={roomId} activeThreadId={activeThread?.threadId} canCreate={!archived} timeZone={timeZone} />}
            budget={<BudgetCard roomId={roomId} isOwner={isOwner && !archived} />}
            switcher={(
              <RoomSwitcher
                current={room} rooms={rooms} hasMentions={badges.hasMentions}
                canCreate={me.isCreator} canLeave={!isOwner} canArchive={isOwner && !archived} push={push}
                onCreate={() => setDialog("room")} onLeave={() => setDialog("leave")} onArchive={() => setDialog("archive")}
              />
            )}
            onPalette={() => setPaletteOpen(true)} onNewChat={() => setDialog("chat")} onRename={(chat) => setDialog({ rename: chat })}
            onArchive={setChatArchived} onMute={mute} onSignOut={signOutToLogin} onCollapse={() => setNav(true)}
          />
        </MobileNav>
        <main inert={covered} className="flex min-w-0 flex-1 flex-col">
          <Header
            roomName={room.name} chatName={activeChat?.name} members={members}
            thread={activeThread && (
              <>
                <ThreadTitle thread={activeThread} />
                <ViewSwitch map={onMap} />
              </>
            )}
            taint={activeThread?.taint} panelOpen={narrow ? overlay === "panel" : panelOpen}
            navCollapsed={navCollapsed} onMenu={() => (phone ? setOverlay("nav") : setNav(false))} onSearch={openSearch} onTogglePanel={togglePanel}
          />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <motion.div key={pathname} {...enter} initial={navigated ? enter.initial : false} className="absolute inset-0">
              <StepPick.Provider value={{ picked, pick: pickStep }}>{children}</StepPick.Provider>
            </motion.div>
          </div>
        </main>
        <Panel
          open={panelOpen}
          overlayOpen={overlay === "panel"}
          active={panelTab}
          onActiveChange={setPanelTab}
          tabs={[
            ...(shownStep ? [{ id: "step", label: "Step", icon: Workflow, content: <StepDetails {...shownStep} /> }] : []),
            ...(activeThread ? [{ id: "context", label: "Context", icon: Activity, content: <RunPanel thread={activeThread} files={files.files} /> }] : []),
            { id: "memory", label: "Memory", icon: NotebookPen, content: <MemoryPanel key={roomId} roomId={roomId} archived={archived} /> },
            {
              id: "agents", label: "Agents", icon: Bot,
              content: <AgentsPanel key={roomId} roomId={roomId} me={meInRoom} rooms={rooms} models={view.models} archived={archived} />,
            },
            {
              id: "schedules", label: "Schedules", icon: CalendarClock,
              content: <SchedulesPanel key={roomId} roomId={roomId} me={meInRoom} chats={view.chats} archived={archived} />,
            },
            {
              id: "files", label: `Files · ${files.files.length}`, icon: Folder,
              content: (
                <FilesPanel
                  roomId={roomId} store={files} threads={threads.threads} internet={view.sandboxInternet}
                  canSwitch={canManage} canWrite={!archived}
                />
              ),
            },
            { id: "connections", label: "Connections", icon: Plug, content: <ConnectionsPanel roomId={roomId} archived={archived} pickGitHub={pickGitHub} onPickStarted={clearPick} /> },
            { id: "members", label: `Members · ${members.length}`, icon: Users, content: <MemberList roomId={roomId} members={members} myRole={view.me.role} myUserId={me.userId} /> },
            ...(canManage ? [{ id: "invite", label: "Invite", icon: UserPlus, content: <InvitePanel roomId={roomId} /> }] : []),
            { id: "search", label: "Search", icon: Search, content: <SearchPanel roomId={roomId} chats={view.chats} serverTimeZone={serverTimeZone} focusSignal={searchFocus} onPick={() => setOverlay(null)} /> },
          ]}
        />
        <Backdrop open={covered} onClose={() => setOverlay(null)} />
      </div>

      <RoomPalette
        open={paletteOpen} onOpenChange={setPaletteOpen} view={view} rooms={rooms} me={me} admin={admin}
        onSearch={openSearch} onDialog={setDialog} onTogglePanel={togglePanel} onSignOut={signOutToLogin}
      />
      <RoomDialogs dialog={dialog} roomId={roomId} roomName={room.name} onClose={() => setDialog(null)} onExit={exitRoom} />
    </ModelsProvider>
  );
}
