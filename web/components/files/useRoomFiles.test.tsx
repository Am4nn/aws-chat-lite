// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import type { RoomFile } from "@/lib/types";
import { useRoomFiles } from "./useRoomFiles";

const handlers = vi.hoisted(() => new Map<string, (e: never) => void>());
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/lib/client/LiveProvider", () => ({ useLiveEvent: (type: string, handler: (e: never) => void) => void handlers.set(type, handler) }));
const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const file = (path: string): RoomFile => ({
  path, size: 1, contentType: "text/plain", v: 1, updatedAt: "t", updatedBy: { kind: "member", userId: "u", name: "bea" },
});

afterEach(() => {
  vi.mocked(bff).mockReset();
  toasts.mockReset();
});

describe("useRoomFiles", () => {
  it("is loading until the list arrives, then ready", async () => {
    vi.mocked(bff).mockResolvedValueOnce({ files: [] });
    const { result } = renderHook(() => useRoomFiles("r1"));
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("ready"));
  });

  it("fails a first load, and a reload tries again", async () => {
    vi.mocked(bff).mockRejectedValueOnce("Something went wrong.").mockResolvedValueOnce({ files: [file("a")] });
    const { result } = renderHook(() => useRoomFiles("r1"));
    await waitFor(() => expect(result.current.state).toBe("failed"));
    act(() => result.current.reload());
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.files.map((f) => f.path)).toEqual(["a"]);
  });

  it("keeps the list it has when fetching again fails", async () => {
    vi.mocked(bff).mockResolvedValueOnce({ files: [file("a")] }).mockRejectedValueOnce("Something went wrong.");
    const { result } = renderHook(() => useRoomFiles("r1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => handlers.get("reconnected")!({} as never));
    await waitFor(() => expect(toasts).toHaveBeenCalledWith("Something went wrong.", "error"));
    expect(result.current.state).toBe("ready");
    expect(result.current.files.map((f) => f.path)).toEqual(["a"]);
  });

  it("drops a deleted file at once, and puts it back when the server refuses", async () => {
    let refuse!: (e: unknown) => void;
    vi.mocked(bff).mockResolvedValueOnce({ files: [file("a"), file("b")] }).mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
    const { result } = renderHook(() => useRoomFiles("r1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.remove("a"));
    expect(result.current.files.map((f) => f.path)).toEqual(["b"]);
    await act(async () => refuse("Archived rooms are read-only."));
    expect(toasts).toHaveBeenCalledWith("Archived rooms are read-only.", "error");
    expect(result.current.files.map((f) => f.path)).toEqual(["a", "b"]);
    expect(result.current.fresh.has("a")).toBe(false);
  });

  it("fetches the list again when an update was too big to send", async () => {
    vi.mocked(bff).mockResolvedValueOnce({ files: [file("a")] }).mockResolvedValueOnce({ files: [file("a"), file("b")] });
    const { result } = renderHook(() => useRoomFiles("r1"));
    await waitFor(() => expect(result.current.files.map((f) => f.path)).toEqual(["a"]));
    act(() => handlers.get("files.updated")!({ type: "files.updated", roomId: "r1", refetch: true } as never));
    await waitFor(() => expect(result.current.files.map((f) => f.path)).toEqual(["a", "b"]));
  });
});
