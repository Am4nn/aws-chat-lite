import { describe, expect, it, vi } from "vitest";

const decide = vi.fn(async () => ({ status: "approved" as const, by: "bea", callbackId: "cb-1" }));
vi.mock("./repo.js", () => ({ approvalsRepo: () => ({ decide }) }));

const { decideApproval } = await import("./decide.js");

describe("decideApproval", () => {
  it("records the decision, then wakes the run with the approval's callback", async () => {
    const wake = vi.fn(async () => {});
    const bea = { userId: "u2", username: "bea" };
    expect(await decideApproval(bea, "run1", 1, "approve", wake)).toEqual({ status: "approved", by: "bea" });
    expect(decide).toHaveBeenCalledWith(bea, "run1", 1, "approve");
    expect(wake).toHaveBeenCalledWith("cb-1");
  });
});
