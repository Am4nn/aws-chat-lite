// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import type { Agent, ModelOption, RoomSummary } from "@/lib/types";
import { AgentsPanel } from "./AgentsPanel";

const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/lib/client/LiveProvider", () => ({ useLiveEvent: () => {} }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const agent = (name: string, over: Partial<Agent> = {}): Agent => ({
  agentId: name, name, instructions: "", tools: ["sandbox", "web"], model: "room", builtIn: false,
  createdBy: "u1", createdByName: "aman", createdAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T10:00:00Z", ...over,
});
const AGENTS = [agent("agent", { builtIn: true, createdBy: "", createdByName: "" }), agent("scout"), agent("critic", { createdBy: "u2", createdByName: "bea" })];
const MODELS: ModelOption[] = [{ pick: "haiku", label: "Haiku", short: "Haiku", price: "$", privateOk: true }];
const room = (roomId: string, role: RoomSummary["role"]): RoomSummary => ({ roomId, name: roomId === "r1" ? "Here" : "Design", role, mentions: 0 });
const mockedBff = vi.mocked(bff);

beforeEach(() => {
  mockedBff.mockImplementation(async (path) => {
    if (path.endsWith("/copy")) return { agent: agent("scout-2"), dropped: ["github"], schedules: { copied: 1, skipped: 0 } };
    if (path.endsWith("/agents")) return { agents: AGENTS, kinds: ["images", "sandbox", "web"] };
    return {};
  });
});
afterEach(() => {
  cleanup();
  mockedBff.mockReset();
  toasts.mockReset();
});

const show = (rooms: RoomSummary[] = [room("r1", "member")]) =>
  render(<AgentsPanel roomId="r1" me={{ userId: "u1", role: "member" }} rooms={rooms} models={MODELS} archived={false} />);

describe("AgentsPanel", () => {
  it("lists each agent with its model, tool kinds and creator", async () => {
    show();
    expect(await screen.findByText("@scout")).toBeTruthy();
    expect(screen.getAllByText("room default")).toHaveLength(3);
    expect(screen.getAllByRole("img", { name: "Tools: Sandbox, Web" })).toHaveLength(3);
    expect(screen.getByText("by bea")).toBeTruthy();
    expect(screen.getByText("built in")).toBeTruthy();
  });

  it("gives a member the menu only for their own agent, and never a Delete for @agent", async () => {
    show();
    await screen.findByText("@scout");
    expect(screen.queryByRole("button", { name: "Actions for @agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions for @critic" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for @scout" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Edit", "Delete"]);
  });

  it("copies into a room I admin and says what didn't come along", async () => {
    show([room("r1", "member"), room("r2", "admin"), room("r3", "member")]);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for @critic" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Copy to Design"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy to Design" }));
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("Copied to Design as @scout-2 · not connected there: github · 1 schedule copied, off"));
    expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/agents/critic/copy", { body: { toRoomId: "r2" } });
  });

  it("offers only the room's tool kinds in the form, with a hint for the rest, and creates the agent", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
    const form = screen.getByRole("button", { name: "Create agent" }).closest("form")!;
    expect((within(form).getByLabelText("GitHub") as HTMLInputElement).disabled).toBe(true);
    expect(within(form).getByRole("button", { name: "Connect GitHub in Connections first." })).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Reviewer" } });
    fireEvent.click(within(form).getByLabelText("Sandbox"));
    fireEvent.click(within(form).getByLabelText("Images"));
    fireEvent.change(within(form).getByLabelText("Model"), { target: { value: "haiku" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create agent" }));
    await vi.waitFor(() => expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/agents", {
      body: { name: "reviewer", instructions: "", tools: ["web"], model: "haiku" },
    }));
  });
});
