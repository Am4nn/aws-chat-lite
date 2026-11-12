// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavPendingProvider } from "./NavPending";
import { NavProgress } from "./NavProgress";

vi.mock("next/navigation", () => ({
  usePathname: () => "/r/r1/c/c1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function view() {
  const result = render(
    <NavPendingProvider>
      <NavProgress />
      <a href="/r/r1/c/c2" onClick={(e) => e.preventDefault()}>random</a>
      <a href="/r/r1/c/c3" onClick={(e) => e.preventDefault()}>design</a>
    </NavPendingProvider>,
  );
  return { ...result, bar: () => result.container.querySelector<HTMLElement>("[data-nav-progress]") };
}

afterEach(cleanup);

describe("NavProgress", () => {
  it("renders nothing while no navigation is in flight", () => {
    expect(view().bar()).toBeNull();
  });

  it("shows one decorative bar while a navigation is in flight, keyed to it so a second tap starts over", () => {
    const { bar } = view();
    fireEvent.click(screen.getByText("random"));
    const first = bar();
    expect(first?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByText("design"));
    expect(bar()).not.toBe(first);
    expect(document.querySelectorAll("[data-nav-progress]")).toHaveLength(1);
  });

  it("stays invisible for the first 120 ms, so a quick navigation never flashes it, then fades in", async () => {
    const { bar } = view();
    fireEvent.click(screen.getByText("random"));
    expect(bar()!.style.opacity).toBe("0");
    await new Promise((r) => setTimeout(r, 60));
    expect(Number(bar()!.style.opacity)).toBe(0);
    await waitFor(() => expect(Number(bar()!.style.opacity)).toBeGreaterThan(0), { timeout: 1000 });
  });
});
