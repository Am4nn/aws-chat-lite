// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import type { MemoryEntry } from "@/lib/types";
import { MemoryPanel } from "./MemoryPanel";

const memoryChanged = vi.hoisted(() => ({ fire: () => {} }));
const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/lib/client/LiveProvider", () => ({
  useLiveEvent: (type: string, handler: (e: { roomId: string }) => void) => {
    if (type === "memory.changed") memoryChanged.fire = () => handler({ roomId: "r1" });
  },
}));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const entry = (memoryId: string, text: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  memoryId, text, private: false, source: { kind: "agent", agent: "reviewer", threadNumber: 12 },
  createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), updatedAt: "", updatedBy: "reviewer", ...over,
});
const same = (m: MemoryEntry): MemoryEntry => ({ ...m, updatedAt: m.createdAt });
let stored: MemoryEntry[] = [];
const mockedBff = vi.mocked(bff);

beforeEach(() => {
  stored = [same(entry("aa", "Deploys go out on Fridays.")), same(entry("bb", "The staging key lives in the vault.", { private: true }))];
  mockedBff.mockImplementation(async (path, init) => {
    if (init?.method === "PATCH") return { entry: { ...stored[0], text: (init.body as { text: string }).text, updatedAt: new Date().toISOString(), updatedBy: "bea" } };
    if (init?.method === "DELETE") return {};
    return { entries: stored };
  });
});
afterEach(() => {
  cleanup();
  mockedBff.mockReset();
});

describe("MemoryPanel", () => {
  it("counts the entries against the cap, says where each came from, and marks private ones", async () => {
    render(<MemoryPanel roomId="r1" archived={false} />);
    expect(await screen.findByText("2 of 50")).toBeTruthy();
    expect(screen.getAllByText("@reviewer in #12 · 2 h ago")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Saved from a thread with private content, so DeepSeek never sees it." })).toHaveLength(1);
  });

  it("edits an entry in place", async () => {
    render(<MemoryPanel roomId="r1" archived={false} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit memory" }))[0]);
    const box = await screen.findByRole("textbox", { name: "Memory" });
    expect(screen.getByText("26/280")).toBeTruthy();
    fireEvent.change(box, { target: { value: "Deploys go out on Thursdays." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Deploys go out on Thursdays.")).toBeTruthy();
    expect(await screen.findByText("edited by bea · just now")).toBeTruthy();
    expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/memory/aa", { method: "PATCH", body: { text: "Deploys go out on Thursdays." } });
  });

  it("deletes only after the confirm", async () => {
    render(<MemoryPanel roomId="r1" archived={false} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Delete memory" }))[1]);
    expect(mockedBff).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(screen.queryByText("The staging key lives in the vault.")).toBeNull());
    expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/memory/bb", { method: "DELETE", body: {} });
  });

  it("marks an entry that arrives after the first load as new", async () => {
    render(<MemoryPanel roomId="r1" archived={false} />);
    await screen.findByText("2 of 50");
    stored = [same(entry("cc", "Standup moved to 10:00.")), ...stored];
    memoryChanged.fire();
    expect(await screen.findByText("3 of 50")).toBeTruthy();
    const fresh = screen.getByRole("listitem", { name: "Standup moved to 10:00." });
    expect(fresh.querySelector("span[aria-hidden]")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Deploys go out on Fridays." }).querySelector(":scope > span[aria-hidden]")).toBeNull();
  });

  it("is read-only in an archived room", async () => {
    render(<MemoryPanel roomId="r1" archived />);
    await screen.findByText("2 of 50");
    expect(screen.queryByRole("button", { name: "Edit memory" })).toBeNull();
  });
});
