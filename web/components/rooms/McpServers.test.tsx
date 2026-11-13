// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import type { McpConnection } from "@/lib/types";
import { McpServers } from "./McpServers";

const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: String }));
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const conn = (name: string, over: Partial<McpConnection> = {}): McpConnection => ({
  name, url: `https://${name}.example/mcp`, auth: "oauth", status: "connected",
  tools: [{ name: "echo", description: "", inputSchema: {}, readOnly: true }, { name: "add_note", description: "", inputSchema: {}, readOnly: false }],
  toolCount: 2, toolsAt: "2026-11-11T12:00:00Z", addedBy: "aman", addedAt: "2026-11-11T12:00:00Z", ...over,
});

/** The panel owns the list; this stands in for it. */
function Panel({ initial, manage }: { initial: McpConnection[]; manage: boolean }) {
  const [servers, setServers] = useState(initial);
  return <McpServers roomId="r1" servers={servers} manage={manage} onChange={setServers} />;
}

afterEach(() => {
  cleanup();
  vi.mocked(bff).mockReset();
  toasts.mockReset();
});

describe("McpServers", () => {
  it("shows a member the list with no way to change it", () => {
    render(<Panel initial={[conn("test"), conn("docs", { status: "needs_auth" })]} manage={false} />);
    const row = screen.getByRole("listitem", { name: "test" });
    expect(within(row).getByText("test.example")).toBeTruthy();
    expect(within(row).getByText("connected")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "docs" })).getByText("needs reconnecting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add MCP server" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("tells a member when there are none", () => {
    render(<Panel initial={[]} manage={false} />);
    expect(screen.getByText("None yet.")).toBeTruthy();
  });

  it("labels each tool once its list is opened", () => {
    render(<Panel initial={[conn("test")]} manage={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Show tools" }));
    expect(within(screen.getByRole("listitem", { name: "echo" })).getByText("read-only")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "add_note" })).getByText("asks first")).toBeTruthy();
  });

  it("connects a server that needs no sign-in and adds its row", async () => {
    vi.mocked(bff).mockResolvedValueOnce({ connection: conn("test") });
    render(<Panel initial={[]} manage />);
    fireEvent.click(screen.getByRole("button", { name: "Add MCP server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "test" } });
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://test.example/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: /^An MCP server's Streamable HTTP address/ }));
    expect(bff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("listitem", { name: "test" })).toBeTruthy());
    expect(bff).toHaveBeenCalledWith("/bff/api/rooms/r1/connections/mcp", {
      body: { name: "test", url: "https://test.example/mcp", redirectUri: `${window.location.origin}/bff/mcp/callback` },
    });
    expect(toasts).toHaveBeenCalledWith("Connected test");
  });

  it("marks the tab before leaving for the server's sign-in, so its return may show a toast", async () => {
    vi.mocked(bff).mockResolvedValueOnce({ authorizeUrl: "https://test.example/authorize?state=s" });
    const navigate = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Panel initial={[conn("test")]} manage />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(sessionStorage.getItem("sign-in-started")).toBe("1"));
    navigate.mockRestore();
    sessionStorage.clear();
  });

  it("offers one-click Linear and Notion to admins, and connects through the usual flow", async () => {
    vi.mocked(bff).mockResolvedValueOnce({ authorizeUrl: "https://mcp.linear.app/authorize" });
    render(<Panel initial={[]} manage />);
    expect(screen.getByRole("button", { name: "Connect Notion" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    await waitFor(() => expect(bff).toHaveBeenCalledWith("/bff/api/rooms/r1/connections/mcp", {
      body: { name: "linear", url: "https://mcp.linear.app/mcp", redirectUri: `${window.location.origin}/bff/mcp/callback` },
    }));
  });

  it("hides a catalog entry the room already has, and the whole catalog from members", () => {
    const { unmount } = render(<Panel initial={[conn("linear", { url: "https://mcp.linear.app/mcp" })]} manage />);
    expect(screen.queryByRole("button", { name: "Connect Linear" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Notion" })).toBeTruthy();
    unmount();
    render(<Panel initial={[]} manage={false} />);
    expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull();
  });

  it("removes a server only after the admin confirms", async () => {
    vi.mocked(bff).mockResolvedValueOnce({});
    render(<Panel initial={[conn("test")]} manage />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Remove test? Agents lose its tools at once.")).toBeTruthy();
    expect(bff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "test" })).toBeNull());
    expect(bff).toHaveBeenCalledWith("/bff/api/rooms/r1/connections/mcp/test", { method: "DELETE", body: {} });
  });
});
