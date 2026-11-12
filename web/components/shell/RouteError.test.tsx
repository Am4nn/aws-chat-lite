// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "./RouteError";

function setOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

const failure = (digest?: string) => Object.assign(new Error("ECONNRESET at fetch (internal)"), { digest });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RouteError", () => {
  it("says nothing was changed and Try again retries, without showing the error's own text", () => {
    const retry = vi.fn();
    render(<RouteError error={failure("4021")} retry={retry} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This didn't load. Nothing was changed.");
    expect(alert.textContent).toContain("4021");
    expect(alert.textContent).not.toContain("ECONNRESET");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("offline, says it will load once back online, and then retries by itself once", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const retry = vi.fn();
    render(<RouteError error={failure()} retry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("You're offline. This will load when you're back online.");
    expect(retry).not.toHaveBeenCalled();
    act(() => setOnline(true));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("This didn't load.");
  });

  it("doesn't retry by itself when it was never offline", () => {
    const retry = vi.fn();
    render(<RouteError error={failure()} retry={retry} />);
    act(() => window.dispatchEvent(new Event("online")));
    expect(retry).not.toHaveBeenCalled();
  });
});
