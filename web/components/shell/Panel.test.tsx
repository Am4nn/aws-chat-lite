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

describe("Panel tabs", () => {
  it("names each icon tab on hover and to screen readers, and names the shown panel by its tab, with no heading of its own", () => {
    const out = html(true);
    expect(out).toContain('aria-label="A" title="A"');
    expect(out).not.toContain("<h2");
    const tabId = out.match(/role="tab"[^>]*id="([^"]+)"|id="([^"]+)"[^>]*role="tab"/)!.slice(1).find(Boolean);
    expect(out).toContain(`aria-labelledby="${tabId}"`);
  });
});

describe("breakpoints", () => {
  // Zoomed windows have fractional widths, so a query of "at most 767px" disagrees with CSS's "under 768px" at 767.2.
  it("asks exactly what Tailwind's max-* variants ask, so behaviour and layout can't split at a fractional width", () => {
    expect(PHONE_QUERY).toBe("(width < 48rem)");
    expect(NARROW_QUERY).toBe("(width < 1152px)");
  });
});
