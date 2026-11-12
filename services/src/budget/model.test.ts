import { describe, expect, it } from "vitest";
import { budgetOf, budgetText, capFromUsd, monthKey, resetsAt } from "./model.js";

describe("monthKey", () => {
  it.each([
    ["2026-11-30T23:59:59Z", "2026-11"],
    ["2026-12-01T00:00:00Z", "2026-12"],
    ["2026-12-01T03:00:00+05:30", "2026-11"],
  ])("%s is %s", (iso, key) => expect(monthKey(new Date(iso))).toBe(key));
});

it("resets on the first of next month", () => {
  expect(resetsAt("2026-12")).toBe("2027-01-01T00:00:00.000Z");
});

describe("budgetOf", () => {
  it("defaults to the $3 cap and nothing spent", () => {
    expect(budgetOf("2026-11")).toEqual({ spentMicros: 0, capMicros: 3_000_000, capRev: 0, month: "2026-11", resetsAt: "2026-12-01T00:00:00.000Z" });
  });
  it("reads the cap from the room and the spend from the month's usage", () => {
    expect(budgetOf("2026-11", { budgetCapMicros: 5_000_000, budgetCapRev: 3 }, { costMicros: 42 })).toMatchObject({ spentMicros: 42, capMicros: 5_000_000, capRev: 3 });
  });
});

describe("capFromUsd", () => {
  it.each([[3, 3_000_000], [2.555, 2_560_000], [0, 0], [20, 20_000_000]])("%j -> %j", (usd, micros) => {
    expect(capFromUsd(usd)).toBe(micros);
  });
  it.each([20.01, -1, "3", NaN])("rejects %j", (raw) => expect(() => capFromUsd(raw)).toThrow(/\$0 and \$20/));
});

it("words the budget message", () => {
  expect(budgetText(3_000_000, "2026-11")).toBe("This room has used its $3.00 budget for November. It resets on December 1 (00:00 UTC).");
});
