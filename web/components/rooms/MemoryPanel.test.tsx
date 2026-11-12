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
    if (type === "memory.changed") memoryChanged.fire = () => handler({ roomId });
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
// The panel cache outlives a test, so each test reads a room of its own.
let roomId = "";
let rooms = 0;

beforeEach(() => {
  roomId = `r${++rooms}`;
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
  toasts.mockReset();
});

describe("MemoryPanel", () => {
  it("counts the entries against the cap, says where each came from, and marks private ones", async () => {
    render(<MemoryPanel roomId={roomId} archived={false} />);
    expect(await screen.findByText("2 of 50")).toBeTruthy();
    expect(screen.getAllByText("@reviewer in #12 · 2 h ago")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Saved from a thread with private content, so DeepSeek never sees it." })).toHaveLength(1);
  });

  it("heads the list with a quiet title row, and shows no count while there is nothing to count", async () => {
    stored = [];
    render(<MemoryPanel roomId={roomId} archived={false} />);
    expect(await screen.findByText("Agents save lasting facts and decisions here as they work.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Memory" })).toBeTruthy();
    expect(screen.queryByText(/of 50/)).toBeNull();
    expect(screen.queryByText(/Nothing yet/)).toBeNull();
  });

  it("edits an entry in place", async () => {
    render(<MemoryPanel roomId={roomId} archived={false} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit memory" }))[0]);
    const box = await screen.findByRole("textbox", { name: "Memory" });
    expect(screen.getByText("26/280")).toBeTruthy();
    fireEvent.change(box, { target: { value: "Deploys go out on Thursdays." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Deploys go out on Thursdays.")).toBeTruthy();
    expect(await screen.findByText("edited by bea · just now")).toBeTruthy();
    expect(mockedBff).toHaveBeenCalledWith(`/bff/api/rooms/${roomId}/memory/aa`, { method: "PATCH", body: { text: "Deploys go out on Thursdays." } });
  });

  it("deletes only after the confirm, taking the row away on the tap", async () => {
    render(<MemoryPanel roomId={roomId} archived={false} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Delete memory" }))[1]);
    expect(mockedBff).toHaveBeenCalledTimes(1);
    mockedBff.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(screen.queryByText("The staging key lives in the vault.")).toBeNull());
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("1 of 50")).toBeTruthy();
    expect(mockedBff).toHaveBeenCalledWith(`/bff/api/rooms/${roomId}/memory/bb`, { method: "DELETE", body: {} });
  });

  it("puts a deleted entry back in its place when the server refuses, and says why", async () => {
    render(<MemoryPanel roomId={roomId} archived={false} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Delete memory" }))[0]);
    mockedBff.mockRejectedValueOnce("Archived rooms are read-only.");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("Archived rooms are read-only.", "error"));
    expect(screen.getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Deploys go out on Fridays.", "The staging key lives in the vault."]);
  });

  it("shows an edit and closes the editor on Save, before the server answers", async () => {
    render(<MemoryPanel roomId={roomId} archived={false} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit memory" }))[0]);
    fireEvent.change(await screen.findByRole("textbox", { name: "Memory" }), { target: { value: "Deploys go out on Thursdays." } });
    mockedBff.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Deploys go out on Thursdays.")).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByRole("textbox", { name: "Memory" })).toBeNull());
  });

  it("reopens the editor with what was typed when the server refuses an edit", async () => {
    render(<MemoryPanel roomId={roomId} archived={false} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit memory" }))[0]);
    fireEvent.change(await screen.findByRole("textbox", { name: "Memory" }), { target: { value: "Deploys go out on Thursdays." } });
    mockedBff.mockRejectedValueOnce("Archived rooms are read-only.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("Archived rooms are read-only.", "error"));
    const box = await screen.findByRole("textbox", { name: "Memory" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Deploys go out on Thursdays.");
    expect(screen.getByRole("listitem", { name: "Deploys go out on Fridays." })).toBeTruthy();
  });

  it("counts entries seen on an earlier visit as already there, so they don't slide in again", async () => {
    const first = render(<MemoryPanel roomId={roomId} archived={false} />);
    await screen.findByText("2 of 50");
    first.unmount();
    render(<MemoryPanel roomId={roomId} archived={false} />);
    expect(screen.getByText("2 of 50")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Deploys go out on Fridays." }).querySelector(":scope > span[aria-hidden]")).toBeNull();
  });

  it("marks an entry that arrives after the first load as new", async () => {
    render(<MemoryPanel roomId={roomId} archived={false} />);
    await screen.findByText("2 of 50");
    stored = [same(entry("cc", "Standup moved to 10:00.")), ...stored];
    memoryChanged.fire();
    expect(await screen.findByText("3 of 50")).toBeTruthy();
    const fresh = screen.getByRole("listitem", { name: "Standup moved to 10:00." });
    expect(fresh.querySelector("span[aria-hidden]")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Deploys go out on Fridays." }).querySelector(":scope > span[aria-hidden]")).toBeNull();
  });

  it("mounts an arriving entry already new, so it slides in rather than appearing in place", async () => {
    render(<MemoryPanel roomId={roomId} archived={false} />);
    await screen.findByText("2 of 50");
    stored = [same(entry("cc", "Standup moved to 10:00.")), ...stored];
    memoryChanged.fire();
    const row = await screen.findByRole("listitem", { name: "Standup moved to 10:00." });
    expect(row.style.opacity).toBe("0");
  });

  it("is read-only in an archived room", async () => {
    render(<MemoryPanel roomId={roomId} archived />);
    await screen.findByText("2 of 50");
    expect(screen.queryByRole("button", { name: "Edit memory" })).toBeNull();
  });
});
