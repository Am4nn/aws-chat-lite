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

import { keepAwsSection, finishAwsSpike } from "./aws-section.js";

describe("keepAwsSection (local spike must not erase the Sydney results)", () => {
  it("carries the aws block from the old report into the new one", () => {
    const old = "# old\n\n<!-- aws:start -->\nSYDNEY\n<!-- aws:end -->\n";
    expect(keepAwsSection(old, "# new local report\n")).toContain("<!-- aws:start -->\nSYDNEY\n<!-- aws:end -->");
  });
  it("leaves the new report alone when the old one had no aws block", () => {
    expect(keepAwsSection("# old\n", "# new\n")).toBe("# new\n");
  });
});

describe("finishAwsSpike (destroy always runs; failures are loud)", () => {
  it("destroys even when writing the report throws, and exits non-zero", () => {
    const calls: string[] = [];
    const code = finishAwsSpike({
      destroy: () => { calls.push("destroy"); },
      writeReport: () => { calls.push("report"); throw new Error("EBUSY"); },
      log: () => {},
    });
    expect(calls).toContain("destroy");
    expect(code).toBe(1);
  });
  it("exits non-zero and prints the manual command when destroy fails", () => {
    const lines: string[] = [];
    const code = finishAwsSpike({ destroy: () => { throw new Error("boom"); }, writeReport: () => {}, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/cdk destroy cl-aws-spike/);
  });
  it("exits 0 when both succeed, destroying before writing", () => {
    const calls: string[] = [];
    expect(finishAwsSpike({ destroy: () => { calls.push("destroy"); }, writeReport: () => { calls.push("report"); }, log: () => {} })).toBe(0);
    expect(calls).toEqual(["destroy", "report"]);
  });
});
