// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpApp } from "@/lib/types";
import { AppsList } from "./AppsList";

const at = new Date().toISOString();
const app = (grantId: string, clientName: string): McpApp => ({ grantId, clientName, scopes: ["rooms:read"], createdAt: at, lastUsedAt: at });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppsList", () => {
  it("says so when no app has access", () => {
    render(<AppsList initial={[]} />);
    expect(screen.getByText("No apps have access.")).toBeTruthy();
  });

  it("removes an app only after you confirm, then drops its row", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    render(<AppsList initial={[app("g1", "Claude Code"), app("g2", "smoke-client")]} />);
    expect(screen.getByText("Claude Code · read only · added just now · last used just now")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove smoke-client" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove smoke-client?" });
    expect(dialog.textContent).toContain("It loses access at once.");
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(/^smoke-client ·/)).toBeNull());
    expect(fetch).toHaveBeenCalledWith("/bff/api/me/apps/g2", expect.objectContaining({ method: "DELETE" }));
    expect(screen.getByText(/^Claude Code ·/)).toBeTruthy();
  });
});
