import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NotFound from "./not-found";

describe("not-found", () => {
  it("says the page is gone and leads back to the rooms without prefetching them", () => {
    const out = renderToStaticMarkup(<NotFound />);
    expect(out).toContain("No such page.");
    expect(out).toContain("The link may be old, or it was removed.");
    expect(out).toMatch(/<a[^>]*href="\/"[^>]*>Go to your rooms<\/a>/);
  });
});
