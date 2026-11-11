// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import type { RoomFile } from "@/lib/types";
import { useRoomFiles } from "./useRoomFiles";

const handlers = vi.hoisted(() => new Map<string, (e: never) => void>());
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/lib/client/LiveProvider", () => ({ useLiveEvent: (type: string, handler: (e: never) => void) => void handlers.set(type, handler) }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => () => {} }));

const file = (path: string): RoomFile => ({
  path, size: 1, contentType: "text/plain", v: 1, updatedAt: "t", updatedBy: { kind: "member", userId: "u", name: "bea" },
});

describe("useRoomFiles", () => {
  it("fetches the list again when an update was too big to send", async () => {
    vi.mocked(bff).mockResolvedValueOnce({ files: [file("a")] }).mockResolvedValueOnce({ files: [file("a"), file("b")] });
    const { result } = renderHook(() => useRoomFiles("r1"));
    await waitFor(() => expect(result.current.files.map((f) => f.path)).toEqual(["a"]));
    act(() => handlers.get("files.updated")!({ type: "files.updated", roomId: "r1", refetch: true } as never));
    await waitFor(() => expect(result.current.files.map((f) => f.path)).toEqual(["a", "b"]));
  });
});
