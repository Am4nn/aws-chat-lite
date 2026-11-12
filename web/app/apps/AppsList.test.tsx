// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpApp } from "@/lib/types";
import { AppsList } from "./AppsList";

const toasts = vi.hoisted(() => vi.fn());
vi.mock("@/components/overlays/Toast", () => ({ useToast: () => toasts }));

const at = new Date().toISOString();
const app = (grantId: string, clientName: string): McpApp => ({ grantId, clientName, scopes: ["rooms:read"], createdAt: at, lastUsedAt: at });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toasts.mockReset();
});

describe("AppsList", () => {
  it("says so when no app has access", () => {
    render(<AppsList initial={[]} />);
    expect(screen.getByText("No apps have access.")).toBeTruthy();
  });

  it("removes an app only after you confirm, dropping its row on the tap", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
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

  it("puts an app back in its place when the server refuses, and says why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "That app is already gone." }, { status: 404 })));
    render(<AppsList initial={[app("g1", "Claude Code"), app("g2", "smoke-client")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Claude Code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(toasts).toHaveBeenCalledWith("That app is already gone.", "error"));
    expect(screen.getAllByRole("button", { name: /^Remove / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Remove Claude Code", "Remove smoke-client"]);
  });
});
