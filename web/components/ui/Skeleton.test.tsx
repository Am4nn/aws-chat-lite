import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Bar, SkeletonRows } from "./Skeleton";

describe("Skeleton", () => {
  it("draws a muted bar the shape it's given", () => {
    expect(renderToStaticMarkup(<Bar className="h-3 w-1/2" />)).toContain("h-3 w-1/2");
  });

  it("takes the radius it is given in place of its own, since Tailwind would keep rounded-md over rounded-full", () => {
    const out = renderToStaticMarkup(<Bar className="size-7 rounded-full" />);
    expect(out).toContain("rounded-full");
    expect(out).not.toContain("rounded-md");
  });

  it("draws rows shaped like panel rows, marked busy and pulsing unless motion is reduced", () => {
    const out = renderToStaticMarkup(<SkeletonRows rows={4} />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("motion-safe:animate-pulse");
    expect(out.match(/data-skeleton-row/g)).toHaveLength(4);
  });
});
