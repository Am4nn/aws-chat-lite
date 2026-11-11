import { describe, expect, it, vi } from "vitest";
import type { PushSender } from "../send.js";
import type { PushJob, StoredSubscription } from "../types.js";
import { deliver, type DeliveryDeps } from "./handler.js";

const sub = (userId: string, id = `${userId}-phone`): StoredSubscription => ({
  id, userId, createdAt: "2026-11-11T10:00:00.000Z", endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: "p", auth: "a" },
});

/** A room `dev` whose members are `memberIds`, each with the devices in `devices`. */
function fakeDeps(opts: { memberIds?: string[]; devices?: StoredSubscription[]; archived?: boolean; result?: (s: StoredSubscription) => "ok" | "gone" | "failed" } = {}) {
  const { memberIds = ["aman", "bea"], devices = [sub("aman"), sub("bea")], archived = false, result = () => "ok" as const } = opts;
  const sent: { to: string; title: string }[] = [];
  const send: PushSender = async (s, note) => {
    sent.push({ to: s.id, title: note.title });
    return result(s);
  };
  const deps = {
    room: vi.fn(async () => ({ name: "dev", archived, memberIds })),
    place: vi.fn(async () => ({ name: "general" })),
    repo: {
      forUsers: vi.fn(async (ids: string[]) => devices.filter((d) => ids.includes(d.userId))),
      remove: vi.fn(async () => {}),
    },
    sender: async () => send,
  } satisfies DeliveryDeps;
  return { deps, sent };
}

const mention: PushJob = {
  kind: "mention", roomId: "R", chatId: "C", seq: 3, authorName: "bea", text: "@aman @cy hi", everyone: false, userIds: ["aman", "cy"],
};

describe("deliver", () => {
  it("tells only targets who are still members", async () => {
    const { deps, sent } = fakeDeps({ devices: [sub("aman"), sub("cy")] });
    await deliver(mention, deps);
    expect(deps.repo.forUsers).toHaveBeenCalledWith(["aman"]);
    expect(sent).toEqual([{ to: "aman-phone", title: "bea mentioned you in #general" }]);
  });

  it("sends to every device and forgets the ones the push service says are gone", async () => {
    const devices = [sub("aman"), sub("aman", "aman-laptop"), sub("aman", "aman-old")];
    const { deps, sent } = fakeDeps({ devices, result: (s) => (s.id === "aman-old" ? "gone" : s.id === "aman-laptop" ? "failed" : "ok") });
    await deliver(mention, deps);
    expect(sent.map((s) => s.to)).toEqual(["aman-phone", "aman-laptop", "aman-old"]);
    expect(deps.repo.remove).toHaveBeenCalledTimes(1);
    expect(deps.repo.remove).toHaveBeenCalledWith("aman", "aman-old");
  });

  it("an approval reaches every member", async () => {
    const { deps, sent } = fakeDeps();
    deps.place.mockResolvedValue({ name: "pr-check" });
    await deliver({ kind: "approval", roomId: "R", threadId: "T", number: 7, runId: "RUN", step: 3, title: "Comment" }, deps);
    expect(deps.repo.forUsers).toHaveBeenCalledWith(["aman", "bea"]);
    expect(sent.map((s) => s.title)).toEqual(["#pr-check needs approval", "#pr-check needs approval"]);
  });

  it("an archived room, or a chat that's gone, sends nothing", async () => {
    const archived = fakeDeps({ archived: true });
    await deliver(mention, archived.deps);
    const removed = fakeDeps();
    removed.deps.place.mockResolvedValue(undefined as never);
    await deliver(mention, removed.deps);
    expect([...archived.sent, ...removed.sent]).toEqual([]);
  });

  it("never throws: a failed delivery is logged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps } = fakeDeps();
    deps.room.mockRejectedValue(new Error("throttled"));
    await expect(deliver(mention, deps)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
