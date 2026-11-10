import { describe, it, expect } from "vitest";
import { renderReport, resultsTable } from "./report.js";

describe("renderReport", () => {
  const md = renderReport(
    [
      { service: "SQS", feature: "x", ok: true, notes: "", ms: 5 },
      { service: "SNS", feature: "y", ok: false, notes: "timeout", ms: 20000 },
    ],
    { flociVersion: "2.4.0", date: "2026-11-06", setupNotes: ["Needs FLAG_X=true"] },
  );

  it("renders a row per check with ✅/❌", () => {
    expect(md).toContain("| SQS | x | ✅ |");
    expect(md).toContain("| SNS | y | ❌ | timeout |");
  });

  it("lists failures under Workarounds needed", () => {
    const section = md.split("## Workarounds needed")[1];
    expect(section).toBeDefined();
    expect(section).toContain("SNS");
    expect(section).not.toContain("SQS");
  });

  it("escapes pipes and flattens newlines so a note can't break the table", () => {
    const row = resultsTable([{ service: "S3", feature: "a|b", ok: true, notes: "one\ntwo", ms: 1 }])[2];
    expect(row).toBe("| S3 | a\\|b | ✅ | one two | 1 |");
  });

  it("records Floci version and date", () => {
    expect(md).toContain("2.4.0");
    expect(md).toContain("2026-11-06");
  });

  it("renders setup notes as a list", () => {
    expect(md).toContain("## Setup notes");
    expect(md).toContain("- Needs FLAG_X=true");
  });
});

describe("renderReport (chat-lite)", () => {
  it("names chat-lite in the intro", () => {
    expect(renderReport([], { flociVersion: "2.4.0", date: "2026-11-10" })).toContain("chat-lite");
  });
});
