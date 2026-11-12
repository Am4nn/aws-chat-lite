// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bffOrNull } from "@/lib/client/bff";
import { InvitePanel } from "./InvitePanel";

const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), bffOrNull: vi.fn(), errorText: String }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));
const mockedLoad = vi.mocked(bffOrNull);

afterEach(() => {
  cleanup();
  mockedLoad.mockReset();
  toasts.mockReset();
});

describe("InvitePanel", () => {
  it("offers a retry when the first load fails, like the other panels, rather than claiming there's no link", async () => {
    mockedLoad.mockRejectedValueOnce(new Error("Something went wrong.")).mockResolvedValueOnce({ code: "abc123", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    render(<InvitePanel roomId="r1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Couldn.t load/ }));
    expect(await screen.findByText("/invite/abc123")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create invite link/ })).toBeNull();
  });

  it("offers to make a link when the room has none", async () => {
    mockedLoad.mockResolvedValueOnce(null);
    render(<InvitePanel roomId="r1" />);
    expect(await screen.findByRole("button", { name: /Create invite link/ })).toBeTruthy();
  });
});
