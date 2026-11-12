// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavPendingProvider, useCurrentPlace, useNavigate, useNavPending } from "./NavPending";

const nav = vi.hoisted(() => ({ pathname: "/r/r1/c/c1", search: "", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
}));

function Probe() {
  const pending = useNavPending();
  const place = useCurrentPlace();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="pending">{pending ?? "none"}</output>
      <output data-testid="chat">{place?.chatId ?? place?.threadNumber ?? "none"}</output>
      {/* Like Next's Link: its own handler takes the click over. */}
      <a href="/r/r1/c/c2" onClick={(e) => e.preventDefault()}>random</a>
      <a href="#plain">plain</a>
      <a href="/apps" onClick={(e) => e.preventDefault()}>apps</a>
      <button onClick={() => navigate("/r/r1/t/4")}>open thread</button>
    </>
  );
}

const view = () => (
  <NavPendingProvider>
    <Probe />
  </NavPendingProvider>
);
const pending = () => screen.getByTestId("pending").textContent;

beforeEach(() => {
  nav.pathname = "/r/r1/c/c1";
  nav.search = "";
  window.history.replaceState(null, "", nav.pathname);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("NavPendingProvider", () => {
  it("makes a link the router took over the current place on the click itself", () => {
    render(view());
    fireEvent.click(screen.getByText("random"));
    expect(pending()).toBe("/r/r1/c/c2");
    expect(screen.getByTestId("chat").textContent).toBe("c2");
  });

  it("ignores a click the router left to the browser", () => {
    render(view());
    fireEvent.click(screen.getByText("plain"));
    expect(pending()).toBe("none");
  });

  it("keeps the room's place while a tap leaves the rooms, since that page has no place to show early", () => {
    render(view());
    fireEvent.click(screen.getByText("apps"));
    expect(pending()).toBe("/apps");
    expect(screen.getByTestId("chat").textContent).toBe("c1");
  });

  it("clears once the route commits, by path or by search", () => {
    const { rerender } = render(view());
    fireEvent.click(screen.getByText("random"));
    nav.pathname = "/r/r1/c/c2";
    rerender(view());
    expect(pending()).toBe("none");

    fireEvent.click(screen.getByText("open thread"));
    expect(pending()).toBe("/r/r1/t/4");
    nav.search = "m=3";
    rerender(view());
    expect(pending()).toBe("none");
  });

  it("gives up after 10 seconds, so a navigation that never lands doesn't keep its skeleton", () => {
    vi.useFakeTimers();
    render(view());
    fireEvent.click(screen.getByText("random"));
    act(() => vi.advanceTimersByTime(9_999));
    expect(pending()).toBe("/r/r1/c/c2");
    act(() => vi.advanceTimersByTime(1));
    expect(pending()).toBe("none");
  });

  it("useNavigate marks the target pending and asks the router to go there", () => {
    render(view());
    fireEvent.click(screen.getByText("open thread"));
    expect(pending()).toBe("/r/r1/t/4");
    expect(nav.push).toHaveBeenCalledWith("/r/r1/t/4");
  });
});
