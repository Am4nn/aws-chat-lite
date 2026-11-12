// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TaintSource } from "@/lib/types";
import { Header } from "./Header";

const header = (taint: TaintSource[], panelOpen = true, navCollapsed = false) =>
  render(<Header roomName="Room" chatName="general" taint={taint} members={[]} panelOpen={panelOpen} navCollapsed={navCollapsed} onMenu={() => {}} onSearch={() => {}} onTogglePanel={() => {}} />);

afterEach(cleanup);

describe("Header", () => {
  it("shows a lock that says what made the thread private", () => {
    header(["sandbox"]);
    expect(screen.getByRole("img", { name: "Private: has sandbox files, so DeepSeek is off." })).toBeTruthy();
  });

  it("shows no lock on a thread with nothing private", () => {
    header([]);
    expect(screen.queryByRole("img", { name: /Private/ })).toBeNull();
  });

  it("offers the sidebar back on a wide screen only once it has been hidden", () => {
    header([], true, false);
    expect(screen.getByRole("button", { name: "Open sidebar" }).className).toContain("md:hidden");
    cleanup();
    header([], true, true);
    expect(screen.getByRole("button", { name: "Open sidebar" }).className).not.toContain("md:hidden");
  });

  it("says whether the room panel is showing", () => {
    header([], false);
    expect(screen.getByRole("button", { name: "Toggle room panel" }).getAttribute("aria-pressed")).toBe("false");
  });
});
