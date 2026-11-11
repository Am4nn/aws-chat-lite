"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { Activity, Bot, CalendarClock, Folder, NotebookPen, Plug, Search, UserPlus, Users, Workflow } from "lucide-react";
import { bff, bffOrNull, errorText } from "@/lib/client/bff";
import { takeFlowMark } from "@/lib/client/flow-return";
import { useLive, useLiveEvent, useLiveStatus } from "@/lib/client/LiveProvider";
import { ModelsProvider } from "@/lib/client/ModelsProvider";
import { signOut } from "@/lib/client/signOut";
import { sidebarThreads } from "@/lib/client/threads";
import { useThreads } from "@/lib/client/ThreadsProvider";
import { useNow } from "@/lib/client/useNow";
import { useTimeZone } from "@/lib/client/useTimeZone";
import { PHONE_QUERY, useIsPhone } from "@/lib/client/useIsPhone";
import { isPaletteShortcut } from "@/lib/keys";
import { enterFrom } from "@/lib/motion";
import { isAdmin, type Chat, type Me, type RoomSummary, type RoomView, type ThreadSummary } from "@/lib/types";
import { CommandPalette, type PaletteItem } from "@/components/overlays/CommandPalette";
import { Confirm } from "@/components/overlays/Confirm";
import { Modal } from "@/components/overlays/Modal";
import { useToast } from "@/components/overlays/Toast";
import { AgentsPanel } from "@/components/rooms/AgentsPanel";
import { ConnectionsPanel } from "@/components/rooms/ConnectionsPanel";
import { CreateChat } from "@/components/rooms/CreateChat";
import { CreateRoom } from "@/components/rooms/CreateRoom";
import { MemberList } from "@/components/rooms/MemberList";
import { MemoryPanel } from "@/components/rooms/MemoryPanel";
import { SchedulesPanel } from "@/components/rooms/SchedulesPanel";
import { InvitePanel } from "@/components/rooms/InvitePanel";
import { inviteUrl } from "@/components/rooms/invite";
import { MentionSound } from "@/components/chat/MentionSound";
import { FilesPanel } from "@/components/files/FilesPanel";
import { useRoomFiles } from "@/components/files/useRoomFiles";
import { SearchPanel } from "@/components/chat/SearchPanel";
import { StepDetails } from "@/components/threads/map/StepDetails";
import { StepPick, type PickedStep } from "@/components/threads/map/stepPick";
import { RunCapsule } from "@/components/threads/RunCapsule";
import { RunPanel } from "@/components/threads/RunPanel";
import { ThreadList } from "@/components/threads/ThreadList";
import { ThreadTitle } from "@/components/threads/ThreadTitle";
import { ViewSwitch } from "@/components/threads/ViewSwitch";
import { BudgetCard } from "./BudgetCard";
import { Header } from "./Header";
import { Backdrop, MobileNav } from "./MobileNav";
import { NeedsYouToast } from "./NeedsYouToast";
import { Panel } from "./Panel";
import { RoomSwitcher } from "./RoomSwitcher";
import { Sidebar } from "./Sidebar";
import { direction, navOrder } from "./nav";
import { useBadges } from "./useBadges";
import { usePresence } from "./usePresence";
import { usePush } from "./usePush";
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
  const { chatId, number } = useParams<{ chatId?: string; number?: string }>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [panelTab, setPanelTab] = useState(number ? "context" : "members");
  const [searchFocus, setSearchFocus] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [picked, setPicked] = useState<PickedStep | null>(null);
  const live = useLive();
  const status = useLiveStatus();
  const { room } = view;
  const roomId = room.roomId;
  const badges = useBadges({ view, rooms, meId: me.userId, activeChatId: chatId });
  const threads = useThreads();
  const timeZone = useTimeZone(serverTimeZone);
  const activeThread = number ? threads.byNumber(Number(number)) : undefined;
  const members = usePresence(view.members, me.userId);
  const files = useRoomFiles(roomId);
  const push = usePush();
  const exitRoom = useRoomExit({ roomId, rooms, onExited: () => setDialog(null) });
  const query = useSearchParams();
  const mcpName = query.get("mcp");
  const mcpError = query.get("mcpError");
  const githubError = query.get("githubError");
  const githubPick = query.get("github") === "pick";
  const [pickGitHub, setPickGitHub] = useState(false);
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

  // Connecting an MCP server or signing in with GitHub comes back here with the result in the address. It is shown
  // once, with the Connections tab open (and the repo picker, after GitHub), then dropped from the address so a reload
  // doesn't show it again.
  useEffect(() => {
    const error = mcpError ?? githubError;
    if (!mcpName && !error && !githubPick) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (!takeFlowMark()) return;
    if (githubPick) setPickGitHub(true);
    else toast(error ?? `Connected ${mcpName}`, error ? "error" : "done");
    setPanelTab("connections");
  }, [mcpName, mcpError, githubError, githubPick, toast]);

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

  /** A step picked on the Map opens in the panel's Step tab. */
  function pickStep(step: PickedStep) {
    setPicked(step);
    setPanelTab("step");
    if (isPhoneNow()) setOverlay("panel");
    else setPanelOpen(true);
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

  async function signOutToLogin() {
    await signOut();
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

  /** Ctrl K's "@agent …": a new thread, opened once the server has numbered it. */
  async function askAgent(text: string) {
    try {
      const { thread } = await bff<{ thread: ThreadSummary }>(`/bff/api/rooms/${roomId}/threads`, { body: { text, clientId: crypto.randomUUID() } });
      threads.apply(thread);
      router.push(`/r/${roomId}/t/${thread.number}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const threadItem = (group: string) => (t: ThreadSummary): PaletteItem => ({
    id: `thread-${t.threadId}`, group, label: `#${t.number} ${t.name}`, icon: <Bot aria-hidden="true" size={13} />,
    run: () => router.push(`/r/${roomId}/t/${t.number}`),
  });
  const paletteItems: PaletteItem[] = [
    ...threads.threads.filter((t) => !t.archived).sort((a, b) => b.number - a.number).map(threadItem("Threads")),
    ...view.chats.map((c) => ({ id: `chat-${c.chatId}`, group: "Chats", label: `#${c.name}`, icon: "#", run: () => router.push(`/r/${roomId}/c/${c.chatId}`) })),
    ...rooms.filter((r) => r.roomId !== roomId)
      .map((r) => ({ id: `room-${r.roomId}`, group: "Rooms", label: r.name, icon: r.name.slice(0, 1).toUpperCase(), run: () => router.push(`/r/${r.roomId}`) })),
    ...(room.archived ? [] : [{ id: "new-thread", group: "Actions", label: "New thread", icon: "+", run: () => router.push(`/r/${roomId}/t/new`) }]),
    { id: "search", group: "Actions", label: "Search messages…", icon: <Search aria-hidden="true" size={13} />, run: openSearch },
    ...(isAdmin(view.me.role) ? [
      { id: "new-chat", group: "Actions", label: "New chat…", icon: "+", run: () => setDialog("chat") },
      { id: "copy-invite", group: "Actions", label: "Copy invite link", icon: "↗", run: copyInvite },
    ] : []),
    ...(me.isCreator ? [{ id: "new-room", group: "Actions", label: "New room…", icon: "+", run: () => setDialog("room") }] : []),
    { id: "panel", group: "Actions", label: "Toggle room panel", icon: "⇥", run: togglePanel },
    { id: "signout", group: "Actions", label: "Sign out", icon: "↩", run: signOutToLogin },
    // Still reachable: a message sent in an archived thread reopens it.
    ...threads.threads.filter((t) => t.archived).sort((a, b) => b.number - a.number).map(threadItem("Archived")),
  ];

  // Only the page that arrives animates. An exiting copy would re-render with the new route (the App Router doesn't
  // freeze a leaving segment), mounting the next page twice; and the page the room opened on is already in place.
  const enter = enterFrom(dir, reducedMotion);
  const activeChat = view.chats.find((c) => c.chatId === chatId);
  const isOwner = view.me.role === "owner";
  const meInRoom = { userId: me.userId, role: view.me.role };

  return (
    <ModelsProvider view={view}>
      <MentionSound meId={me.userId} />
      <NeedsYouToast roomId={roomId} openThreadId={activeThread?.threadId} panelOpen={panelOpen} />
      <div className="flex h-dvh overflow-hidden bg-ink">
        <MobileNav open={overlay === "nav"}>
          <Sidebar
            chats={badges.chats} me={me} roomId={roomId} canAddChat={isAdmin(view.me.role) && !room.archived}
            activeChatId={chatId} newChatIds={newChatIds}
            threads={<ThreadList roomId={roomId} activeThreadId={activeThread?.threadId} canCreate={!room.archived} timeZone={timeZone} />}
            budget={<BudgetCard roomId={roomId} isOwner={isOwner && !room.archived} />}
            switcher={(
              <RoomSwitcher
                current={room} rooms={rooms} hasMentions={badges.hasMentions}
                canCreate={me.isCreator} canLeave={!isOwner} canArchive={isOwner && !room.archived} push={push}
                onCreate={() => setDialog("room")} onLeave={() => setDialog("leave")} onArchive={() => setDialog("archive")}
              />
            )}
            onPalette={() => setPaletteOpen(true)} onNewChat={() => setDialog("chat")} onMute={mute} onSignOut={signOutToLogin}
          />
        </MobileNav>
        <main inert={phone && overlay !== null} className="flex min-w-0 flex-1 flex-col">
          <Header
            roomName={room.name} chatName={activeChat?.name} members={members}
            thread={activeThread && (
              <>
                <ThreadTitle thread={activeThread} />
                {activeThread.runId && <RunCapsule key={activeThread.threadId} thread={activeThread} />}
                <ViewSwitch map={onMap} />
              </>
            )}
            taint={activeThread?.taint}
            onMenu={() => setOverlay("nav")} onSearch={openSearch} onTogglePanel={togglePanel}
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
            { id: "memory", label: "Memory", icon: NotebookPen, content: <MemoryPanel key={roomId} roomId={roomId} archived={room.archived} /> },
            {
              id: "agents", label: "Agents", icon: Bot,
              content: <AgentsPanel key={roomId} roomId={roomId} me={meInRoom} rooms={rooms} models={view.models} archived={room.archived} />,
            },
            {
              id: "schedules", label: "Schedules", icon: CalendarClock,
              content: <SchedulesPanel key={roomId} roomId={roomId} me={meInRoom} chats={view.chats} archived={room.archived} />,
            },
            {
              id: "files", label: `Files · ${files.files.length}`, icon: Folder,
              content: (
                <FilesPanel
                  roomId={roomId} store={files} threads={threads.threads} internet={view.sandboxInternet}
                  canSwitch={isAdmin(view.me.role) && !room.archived} canWrite={!room.archived}
                />
              ),
            },
            { id: "connections", label: "Connections", icon: Plug, content: <ConnectionsPanel roomId={roomId} archived={room.archived} pickGitHub={pickGitHub} onPickStarted={() => setPickGitHub(false)} /> },
            { id: "members", label: `Members · ${members.length}`, icon: Users, content: <MemberList roomId={roomId} members={members} myRole={view.me.role} myUserId={me.userId} /> },
            ...(isAdmin(view.me.role) && !room.archived ? [{ id: "invite", label: "Invite", icon: UserPlus, content: <InvitePanel roomId={roomId} /> }] : []),
            { id: "search", label: "Search", icon: Search, content: <SearchPanel roomId={roomId} chats={view.chats} serverTimeZone={serverTimeZone} focusSignal={searchFocus} onPick={() => setOverlay(null)} /> },
          ]}
        />
        <Backdrop open={overlay !== null} onClose={() => setOverlay(null)} />
      </div>

      <CommandPalette
        open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems}
        agentNames={view.agents.map((a) => a.name)} onAsk={room.archived ? undefined : askAgent}
      />
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
    </ModelsProvider>
  );
}
