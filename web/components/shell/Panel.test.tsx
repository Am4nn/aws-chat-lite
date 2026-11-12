import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Users } from "lucide-react";
import { NARROW_QUERY } from "@/lib/client/useIsPhone";
import { Panel } from "./Panel";

const html = (overlayOpen: boolean) => renderToStaticMarkup(
  <Panel open overlayOpen={overlayOpen} active="a" onActiveChange={() => {}} tabs={[{ id: "a", label: "A", icon: Users, content: <p>a</p> }]} />,
);

describe("Panel", () => {
  it("slides over the chat below the width where sidebar, chat and panel no longer fit side by side", () => {
    expect(NARROW_QUERY).toBe("(max-width: 1151px)");
    const closed = html(false);
    expect(closed).toContain("max-[1151px]:fixed");
    expect(closed).toContain("max-[1151px]:translate-x-full");
    expect(closed).not.toContain("max-md:");
    expect(html(true)).not.toContain("max-[1151px]:translate-x-full");
  });
});
