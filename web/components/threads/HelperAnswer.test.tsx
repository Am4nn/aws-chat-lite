import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelperAnswer } from "./HelperAnswer";

const long = Array.from({ length: 38 }, (_, i) => `line ${i + 1}`).join("\n");

describe("HelperAnswer", () => {
  it("says whose answer it is", () => {
    expect(renderToStaticMarkup(<HelperAnswer agentName="researcher" text="Found 3 notes." />)).toContain("researcher&#x27;s answer");
  });

  it("shows a short answer whole, with nothing to expand", () => {
    const out = renderToStaticMarkup(<HelperAnswer agentName="researcher" text="Found 3 notes." />);
    expect(out).toContain("Found 3 notes.");
    expect(out).not.toContain("line-clamp-4");
    expect(out).not.toContain("Show all");
  });

  it("cuts a long answer to its first 4 lines and offers the rest with its length", () => {
    const out = renderToStaticMarkup(<HelperAnswer agentName="researcher" text={long} />);
    expect(out).toContain("line-clamp-4");
    expect(out).toContain("Show all · 38 lines");
  });

  it("cuts one long paragraph too, which has no line breaks to count", () => {
    const out = renderToStaticMarkup(<HelperAnswer agentName="researcher" text={"word ".repeat(120)} />);
    expect(out).toContain("line-clamp-4");
    expect(out).toMatch(/>Show all</);
  });

  it("says so when the helper gave no answer", () => {
    expect(renderToStaticMarkup(<HelperAnswer agentName="researcher" text="" />)).toContain("No answer.");
  });
});
