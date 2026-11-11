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
    if (path.endsWith("/github/sign-in")) return { authorizeUrl: "https://github.com/login/oauth/authorize?state=s" };
    if (path.endsWith("/github/installations")) return { installations: [{ id: 1, account: "fake-org", repos: ["fake-org/playground"] }] };
    return { entries: [] };
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it("sends an admin to sign in with GitHub before any repos are listed", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { origin: "http://localhost:3000", assign });
    render(<ConnectionsPanel roomId="r1" archived={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=s"));
    expect(mockedBff).toHaveBeenCalledWith("/bff/api/rooms/r1/connections/github/sign-in", { body: { redirectUri: "http://localhost:3000/bff/github/callback" } });
    expect(mockedBff.mock.calls.some(([path]) => path.endsWith("/installations"))).toBe(false);
    expect(sessionStorage.getItem("sign-in-started")).toBe("1");
    sessionStorage.clear();
  });

  it("back from GitHub, opens the picker on what the admin's account can reach, once", async () => {
    const started = vi.fn();
    render(<ConnectionsPanel roomId="r1" archived={false} pickGitHub onPickStarted={started} />);
    expect(await screen.findByRole("checkbox", { name: "fake-org/playground" })).toBeTruthy();
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("opens no picker for a member", async () => {
    mockedBff.mockImplementation(async (path) => {
      if (path.endsWith("/connections")) return { github: null, mcp: [], approvalTimeoutMin: 120, canManage: false, installUrl: null };
      return { entries: [] };
    });
    render(<ConnectionsPanel roomId="r1" archived={false} pickGitHub onPickStarted={() => {}} />);
    expect(await screen.findByText("Not connected")).toBeTruthy();
    expect(mockedBff.mock.calls.some(([path]) => path.endsWith("/installations"))).toBe(false);
  });
});
