// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member, TaintSource } from "@/lib/types";
import { Header } from "./Header";

const header = (taint: TaintSource[], panelOpen = true, navCollapsed = false, onPeople = () => {}, members: Member[] = []) =>
  render(<Header roomName="Room" chatName="general" taint={taint} members={members} panelOpen={panelOpen} navCollapsed={navCollapsed} onMenu={() => {}} onPeople={onPeople} onTogglePanel={() => {}} />);

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

  it("leaves search to the room panel", () => {
    header([]);
    expect(screen.queryByRole("button", { name: /Search/ })).toBeNull();
  });

  it("opens the room's people from the avatar stack", () => {
    const onPeople = vi.fn();
    const members = [{ userId: "u1", username: "aman", role: "owner", online: true }, { userId: "u2", username: "priya", role: "member", online: false }] as Member[];
    header([], true, false, onPeople, members);
    fireEvent.click(screen.getByRole("button", { name: "2 members, 1 online" }));
    expect(onPeople).toHaveBeenCalledOnce();
  });
});
