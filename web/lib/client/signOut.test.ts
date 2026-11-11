import { beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "./bff";
import { disablePush } from "./push";
import { signOut } from "./signOut";

vi.mock("./bff", () => ({ bff: vi.fn(async () => ({})) }));
vi.mock("./push", () => ({ disablePush: vi.fn(async () => {}) }));

describe("signOut", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns this browser's push off while still signed in, so the next account here doesn't get this one's notifications", async () => {
    const order: string[] = [];
    vi.mocked(disablePush).mockImplementation(async () => void order.push("disablePush"));
    vi.mocked(bff).mockImplementation(async (path: string) => void order.push(path));
    await signOut();
    expect(order).toEqual(["disablePush", "/bff/auth/signout"]);
  });

  it("still signs out when push can't be turned off", async () => {
    vi.mocked(disablePush).mockRejectedValue(new Error("offline"));
    await signOut();
    expect(bff).toHaveBeenCalledWith("/bff/auth/signout", { body: {} });
  });
});
