// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import { useRoomData } from "./useRoomData";

const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const mockedBff = vi.mocked(bff);
afterEach(() => {
  mockedBff.mockReset();
  toasts.mockReset();
});

// The cache lives as long as the page, so each test reads its own path.
describe("useRoomData", () => {
  it("shows the last answer at once when the panel comes back, then fetches it again", async () => {
    mockedBff.mockResolvedValueOnce({ n: 1 });
    const first = renderHook(() => useRoomData<{ n: number }>("/p/revisit"));
    await waitFor(() => expect(first.result.current.data).toEqual({ n: 1 }));
    first.unmount();

    let answer!: (v: unknown) => void;
    mockedBff.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const second = renderHook(() => useRoomData<{ n: number }>("/p/revisit"));
    expect(second.result.current.data).toEqual({ n: 1 });
    expect(mockedBff).toHaveBeenCalledTimes(2);
    await act(async () => answer({ n: 2 }));
    expect(second.result.current.data).toEqual({ n: 2 });
  });

  it("keeps a change made on screen for the next visit", async () => {
    mockedBff.mockResolvedValueOnce({ n: 1 });
    const first = renderHook(() => useRoomData<{ n: number }>("/p/changed"));
    await waitFor(() => expect(first.result.current.data).toEqual({ n: 1 }));
    act(() => first.result.current.setData({ n: 5 }));
    first.unmount();

    mockedBff.mockReturnValueOnce(new Promise(() => {}));
    expect(renderHook(() => useRoomData<{ n: number }>("/p/changed")).result.current.data).toEqual({ n: 5 });
  });

  it("keeps what it has when fetching again fails, and says why", async () => {
    mockedBff.mockResolvedValueOnce({ n: 1 });
    const first = renderHook(() => useRoomData<{ n: number }>("/p/offline"));
    await waitFor(() => expect(first.result.current.data).toEqual({ n: 1 }));
    first.unmount();

    mockedBff.mockRejectedValueOnce("Couldn't reach the server.");
    const second = renderHook(() => useRoomData<{ n: number }>("/p/offline"));
    await waitFor(() => expect(toasts).toHaveBeenCalledWith("Couldn't reach the server.", "error"));
    expect(second.result.current.data).toEqual({ n: 1 });
    expect(second.result.current.failed).toBe(false);
  });

  it("fails a first load that has nothing to show", async () => {
    mockedBff.mockRejectedValueOnce("Something went wrong.");
    const { result } = renderHook(() => useRoomData("/p/cold"));
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("shows another path's own answer, not the last one's, when the path changes", async () => {
    mockedBff.mockResolvedValueOnce({ n: 1 });
    const { result, rerender } = renderHook(({ path }) => useRoomData<{ n: number }>(path), { initialProps: { path: "/p/a" } });
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    mockedBff.mockReturnValueOnce(new Promise(() => {}));
    rerender({ path: "/p/b" });
    expect(result.current.data).toBeNull();
  });
});
