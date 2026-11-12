import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelLoading } from "./PanelLoading";

describe("PanelLoading", () => {
  it("shows rows shaped like the list while loading, with no spinner", () => {
    const out = renderToStaticMarkup(<PanelLoading rows={2} />);
    expect(out).toContain('aria-busy="true"');
    expect(out.match(/data-skeleton-row/g)).toHaveLength(2);
    expect(out).not.toContain("animate-spin");
  });

  it("offers a retry after a failure", () => {
    const out = renderToStaticMarkup(<PanelLoading failed onRetry={() => {}} />);
    expect(out).toContain("Couldn&#x27;t load");
    expect(out).not.toContain("data-skeleton-row");
  });
});
