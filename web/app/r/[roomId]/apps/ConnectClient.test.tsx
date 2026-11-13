// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectClient } from "./ConnectClient";

const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const COMMAND = "claude mcp add --transport http chat-lite https://chat.example.com/mcp";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toasts.mockReset();
});

describe("ConnectClient", () => {
  it("shows the command that adds chat-lite's MCP server, and where the client then appears", () => {
    render(<ConnectClient command={COMMAND} />);
    expect(screen.getByText(COMMAND)).toBeTruthy();
    expect(document.body.textContent).toContain("consent page");
  });

  it("copies the command", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ConnectClient command={COMMAND} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    await waitFor(() => expect(toasts).toHaveBeenCalledWith("Command copied"));
  });
});
