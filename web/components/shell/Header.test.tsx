// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TaintSource } from "@/lib/types";
import { Header } from "./Header";

const header = (taint: TaintSource[]) =>
  render(<Header roomName="Room" chatName="general" taint={taint} members={[]} onMenu={() => {}} onSearch={() => {}} onTogglePanel={() => {}} />);

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
});
