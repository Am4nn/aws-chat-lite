import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MobileNav } from "./MobileNav";

const html = (collapsed: boolean) => renderToStaticMarkup(<MobileNav open={false} collapsed={collapsed}><nav /></MobileNav>);

describe("MobileNav", () => {
  it("takes no room on a wide screen once the sidebar is hidden, and its width otherwise", () => {
    expect(html(true)).toContain("md:w-0");
    expect(html(false)).toContain("md:w-[272px]");
  });
});
