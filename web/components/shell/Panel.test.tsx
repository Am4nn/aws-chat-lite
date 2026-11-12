// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Bot } from "lucide-react";
import { Panel } from "./Panel";

const LABELS = ["Context", "Memory", "Agents", "Schedules", "Files · 2", "Connections", "Members · 3", "Invite", "Search"];

function Room() {
  const [active, setActive] = useState("Memory");
  return (
    <Panel
      open overlayOpen={false} active={active} onActiveChange={setActive}
      tabs={LABELS.map((label) => ({ id: label, label, icon: Bot, content: <p>{label} content</p> }))}
    />
  );
}

// jsdom has no media queries; a desktop-width screen is enough here.
beforeAll(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("Panel", () => {
  it("shows every tab as an icon named for screen readers and on hover, and heads the panel with the active one", () => {
    render(<Room />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(LABELS);
    expect(tabs.map((t) => t.getAttribute("title"))).toEqual(LABELS);
    expect(tabs.every((t) => t.textContent === "")).toBe(true);
    expect(screen.getByRole("tabpanel", { name: "Memory" }).textContent).toBe("Memory content");
  });

  it("switches the heading and content with the tab", () => {
    render(<Room />);
    fireEvent.click(screen.getByRole("tab", { name: "Schedules" }));
    expect(screen.getByRole("heading", { name: "Schedules" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Schedules" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Schedules" }).textContent).toBe("Schedules content");
  });

  it("is one Tab stop: arrow keys, Home and End move between the tabs and open them", () => {
    render(<Room />);
    const tab = (name: string) => screen.getByRole("tab", { name });
    expect(screen.getAllByRole("tab").filter((t) => t.tabIndex === 0)).toEqual([tab("Memory")]);
    fireEvent.keyDown(tab("Memory"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Agents"));
    expect(tab("Agents").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("Agents"), { key: "End" });
    expect(document.activeElement).toBe(tab("Search"));
    fireEvent.keyDown(tab("Search"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Context"));
    expect(tab("Context").getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);
  });
});
