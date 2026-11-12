// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavPendingProvider } from "@/components/shell/NavPending";
import { ViewSwitch } from "./ViewSwitch";

vi.mock("next/navigation", () => ({
  usePathname: () => "/r/r1/t/4",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

afterEach(cleanup);

describe("ViewSwitch", () => {
  it("moves to Map on the tap, before the server has answered", () => {
    render(<NavPendingProvider><ViewSwitch /></NavPendingProvider>);
    const map = screen.getByRole("link", { name: "Map" });
    expect(screen.getByRole("link", { name: "Timeline" }).getAttribute("aria-current")).toBe("page");
    map.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(map);
    expect(map.getAttribute("aria-current")).toBe("page");
    expect(map.getAttribute("href")).toBe("/r/r1/t/4?view=map");
  });
});
