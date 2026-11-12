// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ROUTE_SKELETONS } from "./RouteSkeletons";

afterEach(cleanup);

describe("route skeletons", () => {
  it.each(Object.entries(ROUTE_SKELETONS))("%s is one busy, pulsing region with no text a check could match", (kind, Skeleton) => {
    const { container } = render(<Skeleton />);
    const busy = container.querySelectorAll('[aria-busy="true"]');
    expect(busy, kind).toHaveLength(1);
    expect(busy[0]!.getAttribute("aria-label")).toMatch(/^Loading /);
    expect(busy[0]!.className).toContain("motion-safe:animate-pulse");
    expect(container.textContent).toBe("");
  });

  it("covers every room page a tap can wait on", () => {
    expect(Object.keys(ROUTE_SKELETONS).sort()).toEqual(["chat", "map", "new-thread", "thread"]);
  });

  it("the chat and thread skeletons end on the composer's exact box, so the page lands without a jump", () => {
    for (const kind of ["chat", "thread", "new-thread"] as const) {
      const Skeleton = ROUTE_SKELETONS[kind];
      const { container } = render(<Skeleton />);
      const composer = container.querySelector("[data-composer]");
      expect(composer?.className, kind).toContain("max-w-[836px] px-4 pb-5 sm:px-7");
      cleanup();
    }
  });
});
