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
    if (path.endsWith("/agents")) return { agents: AGENTS, kinds: ["images", "sandbox", "web", "room_agents", "room_post", "room_read"], brief: "You work inside chat-lite." };
    return {};
  });
});
afterEach(() => {
  cleanup();
  mockedBff.mockReset();
  toasts.mockReset();
});

// Tests that change the list use a room of their own, since the panel cache outlives a test.
const show = (rooms: RoomSummary[] = [room("r1", "member")], roomId = "r1") =>
  render(<AgentsPanel roomId={roomId} me={{ userId: "u1", role: "member" }} rooms={rooms} models={MODELS} archived={false} />);
const rowNames = () => screen.getAllByText(/^@/).map((n) => n.textContent);

describe("AgentsPanel", () => {
  it("offers a retry when the first load fails, instead of spinning for good", async () => {
    mockedBff.mockRejectedValueOnce(new Error("Something went wrong."));
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Couldn.t load/ }));
    expect(await screen.findByText("@scout")).toBeTruthy();
  });

  it("puts New in the Agents title row", async () => {
    show();
    const title = (await screen.findByRole("heading", { level: 2, name: "Agents" })).parentElement!;
    expect(within(title).getByRole("button", { name: "New agent" })).toBeTruthy();
  });

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
      body: { name: "reviewer", instructions: "", tools: ["web"], model: "haiku", delegates: "all" },
    }));
  });

  it("starts a new agent with the room tools off, and sends a narrowed delegate list", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
    const form = screen.getByRole("button", { name: "Create agent" }).closest("form")!;
    for (const kind of ["room_read", "room_post", "room_agents"]) expect((form.querySelector(`#agent-new-${kind}`) as HTMLInputElement).checked).toBe(false);
    expect((form.querySelector("#agent-new-web") as HTMLInputElement).checked).toBe(true);
    expect(within(form).getByLabelText("Read room")).toBeTruthy();
    expect(within(form).getByLabelText("Post in channels")).toBeTruthy();
    expect(within(form).getByLabelText("Manage agents")).toBeTruthy();
    expect(within(form).queryByLabelText("@scout")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "reviewer" } });
    fireEvent.click(within(form).getByLabelText("Any agent"));
    fireEvent.click(within(form).getByLabelText("@critic"));
    fireEvent.click(within(form).getByRole("button", { name: "Create agent" }));
    await vi.waitFor(() => expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/agents", {
      body: { name: "reviewer", instructions: "", tools: ["images", "sandbox", "web"], model: "room", delegates: ["critic"] },
    }));
  });

  it("shows who made an agent", async () => {
    mockedBff.mockImplementation(async () => ({
      agents: [agent("scout", { madeBy: { agentId: "boss", name: "boss" }, createdByName: "bea" })], kinds: [], brief: "",
    }));
    show([room("r1", "member")], "r-made");
    expect(await screen.findByText("by @boss · approved by bea")).toBeTruthy();
  });

  it("shows, folded and read-only, the brief every agent gets before its own instructions", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
    const form = screen.getByRole("button", { name: "Create agent" }).closest("form")!;
    const note = within(form).getByText("Always included").closest("details")!;
    expect(note.open).toBe(false);
    expect(note.textContent).toContain("You work inside chat-lite.");
    expect(note.querySelector("textarea, input")).toBeNull();
  });

  it("shows the saved agent as the server answered, without waiting for a refetch", async () => {
    show([room("r1", "member")], "r-edit");
    fireEvent.click(await screen.findByRole("button", { name: "Actions for @scout" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    mockedBff.mockResolvedValueOnce({ agent: agent("scout", { model: "haiku" }) });
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull());
    expect(screen.getAllByText("room default")).toHaveLength(2);
    expect(screen.getAllByText("Haiku")).toHaveLength(1);
    expect(mockedBff.mock.calls.filter(([path]) => path.endsWith("/agents"))).toHaveLength(1);
  });

  it("adds a created agent at the end of the list", async () => {
    show([room("r1", "member")], "r-create");
    fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "reviewer" } });
    mockedBff.mockResolvedValueOnce({ agent: agent("reviewer") });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await vi.waitFor(() => expect(rowNames()).toEqual(["@agent", "@scout", "@critic", "@reviewer"]));
  });

  it("deletes on the confirm's tap, and puts the agent back in its place when the server refuses", async () => {
    show([room("r1", "member")], "r-delete");
    fireEvent.click(await screen.findByRole("button", { name: "Actions for @scout" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    let refuse!: (e: unknown) => void;
    mockedBff.mockReturnValueOnce(new Promise((_, reject) => { refuse = reject; }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete agent" }));
    await vi.waitFor(() => expect(rowNames()).toEqual(["@agent", "@critic"]));
    refuse("Only its creator or an admin can do that.");
    await vi.waitFor(() => expect(toasts).toHaveBeenCalledWith("Only its creator or an admin can do that.", "error"));
    await vi.waitFor(() => expect(rowNames()).toEqual(["@agent", "@scout", "@critic"]));
  });
});
