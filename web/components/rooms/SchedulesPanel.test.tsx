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
const CHATS: Chat[] = [{ chatId: "c1", name: "general", lastSeq: 0, unread: 0, mentions: 0, muted: false }];
const mockedBff = vi.mocked(bff);

beforeEach(() => {
  mockedBff.mockImplementation(async (path) => (path.endsWith("/schedules") ? { schedules: [schedule()], timeZone: "Asia/Kolkata", max: 5 } : {}));
});
afterEach(() => {
  cleanup();
  mockedBff.mockReset();
  toasts.mockReset();
});

const show = (userId = "u1", role: Role = "member") => render(
  <RoomAgentsContext value={[agent("agent"), agent("scout")]}>
    <SchedulesPanel roomId="r1" me={{ userId, role }} chats={CHATS} archived={false} />
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

  it("creates a weekly schedule from the form", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
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
});
