// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Chat, RoomView } from "@/lib/types";
import { useBadges } from "./useBadges";

vi.mock("@/lib/client/LiveProvider", () => ({ useLiveEvent: () => {} }));

const chat = (chatId: string, unread: number): Chat => ({ chatId, name: chatId, lastSeq: 0, unread, mentions: 0, muted: false, archived: false });
const ROOMS: never[] = [];
const view = { room: { roomId: "r1" }, chats: [chat("c1", 0), chat("c2", 4), chat("c3", 2)] } as unknown as RoomView;

describe("useBadges", () => {
  it("holds no count on the open chat, nor on the one a tap is opening", () => {
    const { result } = renderHook(() => useBadges({ view, rooms: ROOMS, meId: "u1", openChatIds: ["c1", "c2"] }));
    expect(result.current.chats.map((c) => c.unread)).toEqual([0, 0, 2]);
  });

  it("archives and unarchives a chat in place, before the server answers", () => {
    const { result } = renderHook(() => useBadges({ view, rooms: ROOMS, meId: "u1", openChatIds: ["c1"] }));
    act(() => result.current.setArchived("c3", true));
    expect(result.current.chats.find((c) => c.chatId === "c3")?.archived).toBe(true);
    act(() => result.current.setArchived("c3", false));
    expect(result.current.chats.find((c) => c.chatId === "c3")?.archived).toBe(false);
  });
});
