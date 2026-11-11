// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PushState } from "@/lib/client/push";
import { NotificationsToggle } from "./NotificationsToggle";

const toggle = (state: PushState, onToggle = () => {}) => render(<NotificationsToggle state={state} onToggle={onToggle} />);

afterEach(cleanup);

describe("NotificationsToggle", () => {
  it("off and on are a switch that turns them the other way", () => {
    const onToggle = vi.fn();
    toggle("off", onToggle);
    expect(screen.getByText("Notifications: off")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Turn on" }));
    expect(onToggle).toHaveBeenCalled();
    cleanup();
    toggle("on");
    expect(screen.getByText("Notifications: on")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Turn off" }).getAttribute("aria-checked")).toBe("true");
  });

  it("says why there's no switch, with the way out as a hint", () => {
    toggle("install");
    expect(screen.getByText("On iPhone, add chat-lite to your Home Screen first")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share ▸ Add to Home Screen, then open it from there." })).toBeTruthy();
    cleanup();
    toggle("blocked");
    expect(screen.getByText("Notifications are blocked for this site")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow them in your browser's site settings." })).toBeTruthy();
    cleanup();
    toggle("unsupported");
    expect(screen.getByText("This browser can't show notifications")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("is absent where the server can't send notifications", () => {
    expect(toggle("hidden").container.innerHTML).toBe("");
  });
});
