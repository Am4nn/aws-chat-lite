import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Users } from "lucide-react";
import { NARROW_QUERY, PHONE_QUERY } from "@/lib/client/useIsPhone";
import { Panel } from "./Panel";

const html = (overlayOpen: boolean) => renderToStaticMarkup(
  <Panel open overlayOpen={overlayOpen} active="a" onActiveChange={() => {}} tabs={[{ id: "a", label: "A", icon: Users, content: <p>a</p> }]} />,
);

describe("Panel", () => {
  it("slides over the chat below the width where sidebar, chat and panel no longer fit side by side", () => {
    expect(NARROW_QUERY).toBe("(width < 1152px)");
    const closed = html(false);
    expect(closed).toContain("max-[1152px]:fixed");
    expect(closed).toContain("max-[1152px]:translate-x-full");
    expect(closed).not.toContain("max-md:");
    expect(html(true)).not.toContain("max-[1152px]:translate-x-full");
  });
});

describe("breakpoints", () => {
  // Zoomed windows have fractional widths, so a query of "at most 767px" disagrees with CSS's "under 768px" at 767.2.
  it("asks exactly what Tailwind's max-* variants ask, so behaviour and layout can't split at a fractional width", () => {
    expect(PHONE_QUERY).toBe("(width < 48rem)");
    expect(NARROW_QUERY).toBe("(width < 1152px)");
  });
});
