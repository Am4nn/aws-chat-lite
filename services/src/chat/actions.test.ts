import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastToRoom, sendToConnection } from "../live/broadcast.js";
import { routeSend } from "../threads/route.js";
import { handleAction } from "./actions.js";
import { chatRepo } from "./repo.js";

vi.mock("../live/broadcast.js", () => ({ broadcastToRoom: vi.fn(), sendToConnection: vi.fn(), sendToUser: vi.fn() }));
vi.mock("../live/connections.js", () => ({ subscribe: vi.fn() }));
vi.mock("../runs/stop.js", () => ({ requestStop: vi.fn() }));
vi.mock("../threads/route.js", () => ({ routeSend: vi.fn() }));
vi.mock("./repo.js", () => ({ chatRepo: vi.fn() }));

const user = { userId: "u1", username: "aman" };
const acks = () => vi.mocked(sendToConnection).mock.calls.map(([, event]) => event);

afterEach(() => vi.clearAllMocks());

describe("handleAction", () => {
  it("a send whose broadcast fails is still routed to the agent", async () => {
    const route = vi.fn();
    vi.mocked(routeSend).mockResolvedValue({ message: { roomId: "r1" }, route } as never);
    vi.mocked(broadcastToRoom).mockRejectedValue(new Error("throttled"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handleAction("c1", user, { action: "send", requestId: "q1", roomId: "r1", chatId: "c", clientId: "k1", text: "hi" });
    expect(acks()).toEqual([expect.objectContaining({ type: "ack", requestId: "q1", ok: true })]);
    expect(route).toHaveBeenCalled();
  });

  it("a reaction outside the six is refused before anything is stored", async () => {
    const react = vi.fn();
    vi.mocked(chatRepo).mockReturnValue({ react } as never);
    await handleAction("c1", user, { action: "react", requestId: "q2", roomId: "r1", chatId: "c", seq: 1, reaction: "fire", on: true });
    expect(acks()).toEqual([expect.objectContaining({ requestId: "q2", ok: false, error: expect.stringContaining("six reactions") })]);
    expect(react).not.toHaveBeenCalled();
  });
});
