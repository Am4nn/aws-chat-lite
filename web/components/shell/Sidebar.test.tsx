// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/lib/types";
import { Sidebar } from "./Sidebar";

const chat = (chatId: string, name: string, archived = false): Chat => ({ chatId, name, lastSeq: 0, unread: 0, mentions: 0, muted: false, archived });
const CHATS = [chat("c1", "general"), chat("c2", "random"), chat("c3", "old", true)];

function sidebar(opts: { canManage?: boolean; activeChatId?: string } = {}) {
  const handlers = { onRename: vi.fn(), onArchive: vi.fn(), onMute: vi.fn(), onCollapse: vi.fn() };
  render(
    <Sidebar
      chats={CHATS} me={{ userId: "u1", username: "aman", isCreator: true }} roomId="r1" canManage={opts.canManage ?? false}
      switcher={null} threads={null} budget={null} activeChatId={opts.activeChatId} newChatIds={new Set()}
      onPalette={() => {}} onNewChat={() => {}} onSignOut={() => {}} {...handlers}
    />,
  );
  return handlers;
}

const chatsList = () => within(screen.getByRole("list", { name: "Chats" }));
const menuFor = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Options for #${name}` }));
  // A menu just closed may still be fading out, so the newest is the one that opened.
  return within(screen.getAllByRole("menu").at(-1)!);
};

afterEach(cleanup);

describe("Sidebar", () => {
  it("hides itself from a button that only wide screens show (a phone closes the drawer instead)", () => {
    const { onCollapse } = sidebar();
    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    expect(hide.className).toContain("max-md:hidden");
    fireEvent.click(hide);
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("opens Connected apps inside this room, so the sidebar stays", () => {
    sidebar();
    expect(screen.getByRole("link", { name: "Connected apps" }).getAttribute("href")).toBe("/r/r1/apps");
  });
});

describe("Sidebar chats", () => {
  it("leaves archived chats out of the list, and a member gets no way to them but a link or search", () => {
    sidebar();
    expect(chatsList().getAllByRole("link").map((a) => a.textContent)).toEqual(["general", "random"]);
    expect(screen.queryByRole("button", { name: /Archived/ })).toBeNull();
    expect(menuFor("random").queryByRole("menuitem", { name: /Rename|Archive/ })).toBeNull();
  });

  it("gives an admin a closed Archived list that opens to unarchive", () => {
    const { onArchive } = sidebar({ canManage: true });
    const toggle = screen.getByRole("button", { name: "Archived chats · 1" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Archived chats" })).toBeNull();
    fireEvent.click(toggle);
    expect(within(screen.getByRole("list", { name: "Archived chats" })).getByRole("link").textContent).toBe("old");
    fireEvent.click(menuFor("old").getByRole("menuitem", { name: "Unarchive" }));
    expect(onArchive).toHaveBeenCalledWith(CHATS[2], false);
  });

  it("opens the Archived list when the open chat is in it", () => {
    sidebar({ canManage: true, activeChatId: "c3" });
    expect(screen.getByRole("list", { name: "Archived chats" })).toBeTruthy();
  });

  it("lets an admin rename any chat and archive any but the room's first", () => {
    const { onRename, onArchive } = sidebar({ canManage: true });
    expect(menuFor("general").queryByRole("menuitem", { name: "Archive" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledWith(CHATS[0]);
    fireEvent.click(menuFor("random").getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledWith(CHATS[1], true);
  });
});
