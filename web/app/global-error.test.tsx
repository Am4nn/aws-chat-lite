import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GlobalError from "./global-error";

describe("global-error", () => {
  it("draws its own page, says nothing was changed and offers Try again, without the error's own text", () => {
    const error = Object.assign(new Error("TypeError: x is undefined"), { digest: "77" });
    const out = renderToStaticMarkup(<GlobalError error={error} retry={() => {}} />);
    expect(out).toMatch(/^<html/);
    expect(out).toContain("chat-lite didn&#x27;t load. Nothing was changed.");
    expect(out).toContain("77");
    expect(out).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(out).not.toContain("x is undefined");
  });
});
