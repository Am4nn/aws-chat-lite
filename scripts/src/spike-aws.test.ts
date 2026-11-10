import { describe, it, expect } from "vitest";
import { replaceAwsSection } from "./aws-section.js";

describe("replaceAwsSection", () => {
  it("replaces the marked section", () => {
    const doc = replaceAwsSection("a\n<!-- aws:start -->\nold\n<!-- aws:end -->\nb", "new");
    expect(doc).toContain("new");
    expect(doc).not.toContain("old");
    expect(doc.startsWith("a\n")).toBe(true);
    expect(doc.trimEnd().endsWith("b")).toBe(true);
  });
  it("appends the section when there are no markers", () => {
    const doc = replaceAwsSection("# report\n", "new");
    expect(doc).toContain("<!-- aws:start -->\nnew\n<!-- aws:end -->");
  });
});
