// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import { ConnectionsPanel } from "./ConnectionsPanel";

vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/lib/client/LiveProvider", () => ({ useLiveEvent: () => {} }));

const mockedBff = vi.mocked(bff);
const puts = () => mockedBff.mock.calls.filter(([, init]) => init?.method === "PUT");

beforeEach(() => {
  mockedBff.mockReset();
  mockedBff.mockImplementation(async (path, init) => {
    if (path.endsWith("/connections")) return { github: null, mcp: [], approvalTimeoutMin: 120, canManage: true, installUrl: null };
    if (path.endsWith("/approval-timeout")) return { approvalTimeoutMin: (init?.body as { minutes: number }).minutes };
    return { entries: [] };
  });
});
afterEach(cleanup);

async function editTimeout() {
  render(<ConnectionsPanel roomId="r1" archived={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Change the approval timeout" }));
  return screen.getByRole("textbox", { name: /Approval timeout in minutes/ });
}

describe("ConnectionsPanel", () => {
  it("names the Approvals heading without its hint", async () => {
    render(<ConnectionsPanel roomId="r1" archived={false} />);
    expect(await screen.findByRole("heading", { name: "Approvals" })).toBeTruthy();
  });

  it("saves the timeout when the field loses focus, as the iPhone number pad's Done does", async () => {
    const field = await editTimeout();
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.blur(field);
    await screen.findByText("30 min");
    expect(puts()).toEqual([["/bff/api/rooms/r1/approval-timeout", { method: "PUT", body: { minutes: 30 } }]]);
  });

  it("cancels on Escape, and the blur that follows saves nothing", async () => {
    const field = await editTimeout();
    fireEvent.change(field, { target: { value: "45" } });
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.blur(field);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByText("2 h")).toBeTruthy();
    expect(puts()).toEqual([]);
  });

  it("saves nothing when the value didn't change", async () => {
    const field = await editTimeout();
    fireEvent.blur(field);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(puts()).toEqual([]);
  });
});
