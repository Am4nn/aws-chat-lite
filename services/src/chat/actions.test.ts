import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastToRoom, sendToConnection } from "../live/broadcast.js";
import { routeSend } from "../threads/route.js";
import { handleAction } from "./actions.js";

const repo = vi.hoisted(() => ({ remove: vi.fn(), react: vi.fn() }));

vi.mock("../live/broadcast.js", () => ({ broadcastToRoom: vi.fn(), sendToConnection: vi.fn(), sendToUser: vi.fn() }));
vi.mock("../live/connections.js", () => ({ subscribe: vi.fn() }));
vi.mock("../runs/stop.js", () => ({ requestStop: vi.fn() }));
vi.mock("../threads/route.js", () => ({ routeSend: vi.fn() }));
vi.mock("./repo.js", () => ({ chatRepo: () => repo }));

const user = { userId: "u1", username: "aman" };
const acks = () => vi.mocked(sendToConnection).mock.calls.map(([, event]) => event);

afterEach(() => vi.resetAllMocks());

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

  it("a delete tells the room about the message and its copy in each thread", async () => {
    const message = { roomId: "r1", chatId: "c", seq: 1 };
    const copies = [{ roomId: "r1", chatId: "t1", seq: 2 }, { roomId: "r1", chatId: "t2", seq: 4 }];
    repo.remove.mockResolvedValue({ message, copies });
    await handleAction("c1", user, { action: "delete", requestId: "q3", roomId: "r1", chatId: "c", seq: 1 });
    expect(vi.mocked(broadcastToRoom).mock.calls).toEqual([
      ["r1", { type: "message.updated", message }], ["r1", { type: "message.updated", message: copies[0] }],
      ["r1", { type: "message.updated", message: copies[1] }],
    ]);
  });

  it("a reaction outside the six is refused before anything is stored", async () => {
    await handleAction("c1", user, { action: "react", requestId: "q2", roomId: "r1", chatId: "c", seq: 1, reaction: "fire", on: true });
    expect(acks()).toEqual([expect.objectContaining({ requestId: "q2", ok: false, error: expect.stringContaining("six reactions") })]);
    expect(repo.react).not.toHaveBeenCalled();
  });

  it("any other failure is acked with the default line and logged, never in its own words", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = Object.assign(new Error("User: arn:aws:sts::123456789012:assumed-role/cl-role/fn is not authorized"), { name: "AccessDeniedException" });
    repo.remove.mockRejectedValue(denied);
    await handleAction("c1", user, { action: "delete", requestId: "q4", roomId: "r1", chatId: "c", seq: 1 });
    expect(acks()).toEqual([{ type: "ack", requestId: "q4", ok: false, error: "Something went wrong." }]);
    expect(logged.mock.calls.flat()).toContain(denied);
  });
});
