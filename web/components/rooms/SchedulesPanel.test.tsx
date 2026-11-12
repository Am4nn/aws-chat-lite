// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomAgentsContext } from "@/lib/client/agents";
import { bff, BffError } from "@/lib/client/bff";
import type { Agent, Chat, Role, Schedule } from "@/lib/types";
import { SchedulesPanel } from "./SchedulesPanel";

const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/bff", async (actual) => ({ ...(await actual<object>()), bff: vi.fn() }));
vi.mock("@/lib/client/LiveProvider", () => ({ useLiveEvent: () => {} }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const agent = (agentId: string): Agent => ({
  agentId, name: agentId, instructions: "", tools: [], model: "room", builtIn: agentId === "agent",
  createdBy: "u1", createdByName: "aman", createdAt: "", updatedAt: "",
});
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  scheduleId: "s1", agentId: "scout", title: "Morning digest", prompt: "Summarise new PRs.", cadence: { kind: "daily", time: "09:00" },
  chatId: "c1", enabled: true, createdBy: "u1", createdByName: "aman", createdAt: "2026-11-10T00:00:00Z", nextAt: "2026-11-11T03:30:00.000Z", ...over,
});
const chat = (chatId: string, name: string, archived = false): Chat => ({ chatId, name, lastSeq: 0, unread: 0, mentions: 0, muted: false, archived });
const CHATS: Chat[] = [chat("c1", "general"), chat("c2", "old", true)];
const mockedBff = vi.mocked(bff);

beforeEach(() => {
  mockedBff.mockImplementation(async (path) => (path.endsWith("/schedules") ? { schedules: [schedule()], timeZone: "Asia/Kolkata", max: 5 } : {}));
});
afterEach(() => {
  cleanup();
  mockedBff.mockReset();
  toasts.mockReset();
});

// Tests that change the list use a room of their own, since the panel cache outlives a test.
const show = (userId = "u1", role: Role = "member", roomId = "r1") => render(
  <RoomAgentsContext value={[agent("agent"), agent("scout")]}>
    <SchedulesPanel roomId={roomId} me={{ userId, role }} chats={CHATS} archived={false} />
  </RoomAgentsContext>,
);

describe("SchedulesPanel", () => {
  it("shows each schedule's agent, cadence and next run on the room's clock", async () => {
    show();
    expect(await screen.findByText("1 of 5")).toBeTruthy();
    expect(screen.getByText("@scout")).toBeTruthy();
    expect(screen.getByText(/Every day at 09:00/)).toBeTruthy();
    expect(screen.getByText("next Wed 09:00")).toBeTruthy();
    expect(screen.getByText("Asia/Kolkata")).toBeTruthy();
  });

  it("puts New in the title row in place of the count while there are none", async () => {
    mockedBff.mockImplementation(async () => ({ schedules: [], timeZone: "Asia/Kolkata", max: 5 }));
    show("u1", "member", "r-empty");
    const title = (await screen.findByRole("heading", { level: 2, name: "Schedules" })).parentElement!;
    expect(within(title).getByRole("button", { name: "New schedule" })).toBeTruthy();
    expect(screen.queryByText(/of 5/)).toBeNull();
    expect(screen.queryByText(/None yet/)).toBeNull();
  });

  it("switches a schedule off at once, and back when the server refuses", async () => {
    mockedBff.mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") throw new BffError(503, "Couldn't turn the schedule on; try again.");
      return { schedules: [schedule()], timeZone: "Asia/Kolkata", max: 5 };
    });
    show();
    const toggle = await screen.findByRole("switch", { name: "Morning digest on" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("Couldn't turn the schedule on; try again.", "error"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/schedules/s1", { method: "PATCH", body: { enabled: false } });
  });

  it("leaves another member's schedule alone", async () => {
    show("u2");
    await screen.findByText("1 of 5");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Morning digest" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Times in" })).toBeNull();
  });

  it("lets an admin move the room to another time zone", async () => {
    show("u2", "admin");
    fireEvent.change(await screen.findByRole("combobox", { name: "Times in" }), { target: { value: "Europe/London" } });
    await vi.waitFor(() => expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/timezone", { method: "PUT", body: { timeZone: "Europe/London" } }));
  });

  it("offers no archived chat to post in, except the one a schedule already posts into", async () => {
    mockedBff.mockImplementation(async () => ({ schedules: [schedule({ chatId: "c2" })], timeZone: "Asia/Kolkata", max: 5 }));
    // The form swaps in once the row has faded out.
    const chatsOffered = async () => within(await screen.findByLabelText("Post in")).getAllByRole("option").map((o) => o.textContent);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Morning digest" }));
    expect(await chatsOffered()).toEqual(["#general", "#old (archived)"]);
    cleanup();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New schedule" }));
    expect(await chatsOffered()).toEqual(["#general"]);
  });

  it("creates a weekly schedule from the form", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New schedule" }));
    const form = screen.getByRole("button", { name: "Create schedule" }).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Weekly review" } });
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "Review the week." } });
    fireEvent.change(within(form).getByLabelText("Runs"), { target: { value: "weekly" } });
    fireEvent.change(within(form).getByLabelText("On"), { target: { value: "fri" } });
    fireEvent.change(within(form).getByLabelText("At"), { target: { value: "17:30" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create schedule" }));
    await vi.waitFor(() => expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/schedules", {
      body: { agentId: "agent", title: "Weekly review", prompt: "Review the week.", cadence: { kind: "weekly", day: "fri", time: "17:30" }, chatId: "c1" },
    }));
  });

  it("closes the form after a create the server kept switched off, so a second press can't make a copy", async () => {
    mockedBff.mockImplementation(async (path, init) => {
      if (init?.body) throw new BffError(503, "Couldn't turn the schedule on; try again.");
      return { schedules: [schedule()], timeZone: "Asia/Kolkata", max: 5 };
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New schedule" }));
    const form = screen.getByRole("button", { name: "Create schedule" }).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Weekly review" } });
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "Review the week." } });
    fireEvent.click(within(form).getByRole("button", { name: "Create schedule" }));
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("Couldn't turn the schedule on; try again.", "error"));
    expect(screen.queryByRole("button", { name: "Create schedule" })).toBeNull();
  });

  it("shows the saved schedule as the server answered, without waiting for a refetch", async () => {
    show("u1", "member", "r-edit");
    fireEvent.click(await screen.findByRole("button", { name: "Edit Morning digest" }));
    const form = (await screen.findByRole("button", { name: "Save" })).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Evening digest" } });
    mockedBff.mockResolvedValueOnce({ schedule: schedule({ title: "Evening digest" }) });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Evening digest")).toBeTruthy();
    expect(mockedBff.mock.calls.filter(([path]) => path.endsWith("/schedules"))).toHaveLength(1);
  });

  it("adds a created schedule to the list", async () => {
    show("u1", "member", "r-create");
    fireEvent.click(await screen.findByRole("button", { name: "New schedule" }));
    const form = screen.getByRole("button", { name: "Create schedule" }).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Weekly review" } });
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "Review the week." } });
    mockedBff.mockResolvedValueOnce({ schedule: schedule({ scheduleId: "s2", title: "Weekly review" }) });
    fireEvent.click(within(form).getByRole("button", { name: "Create schedule" }));
    expect(await screen.findByText("2 of 5")).toBeTruthy();
    expect(screen.getByText("Weekly review")).toBeTruthy();
  });

  it("deletes on the confirm's tap, and puts the schedule back when the server refuses", async () => {
    show("u1", "member", "r-delete");
    fireEvent.click(await screen.findByRole("button", { name: "Delete Morning digest" }));
    let refuse!: (e: unknown) => void;
    mockedBff.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete schedule" }));
    await vi.waitFor(() => expect(screen.queryByText("Morning digest")).toBeNull());
    refuse(new BffError(403, "Only its creator or an admin can do that."));
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("Only its creator or an admin can do that.", "error"));
    expect(await screen.findByText("1 of 5")).toBeTruthy();
  });
});
