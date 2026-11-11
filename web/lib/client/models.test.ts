import { describe, expect, it } from "vitest";
import type { ModelOption } from "../types";
import { footerText, modelLabel, nextEnabled, pickMenu, pillLabel } from "./models";

const o = (pick: ModelOption["pick"], label: string, short: string, id: string | undefined, privateOk = true): ModelOption => ({
  pick, id, label, short, price: id ? "$2 / $10" : "", privateOk,
});
const models: ModelOption[] = [
  o("auto", "Auto", "Auto", undefined),
  o("sonnet", "Sonnet 5.5", "Sonnet", "claude-sonnet-5-5"),
  o("haiku", "Haiku 5.5", "Haiku", "claude-haiku-5-5"),
  o("opus", "Opus 5.5", "Opus", "claude-opus-5-5"),
  o("fable", "Fable 5.2", "Fable", "claude-fable-5-2"),
  o("deepseek-flash", "DeepSeek Flash", "DS Flash", "deepseek-flash", false),
  o("deepseek-pro", "DeepSeek Pro", "DS Pro", "deepseek-v4-pro", false),
];
const state: Parameters<typeof pickMenu>[1] = { value: "auto", roomDefault: "auto", taint: [], isAdmin: false };

describe("pickMenu", () => {
  it("disables DeepSeek on a private thread and says why", () => {
    const m = pickMenu(models, { ...state, taint: ["attachment"] });
    expect(m.items.filter((i) => i.disabled).map((i) => i.pick)).toEqual(["deepseek-flash", "deepseek-pro"]);
    expect(m.privateNote).toBe(true);
  });

  it("disables nothing without taint", () => {
    const m = pickMenu(models, state);
    expect(m.items.some((i) => i.disabled)).toBe(false);
    expect(m.privateNote).toBe(false);
  });

  it("marks the selected pick and only the room default", () => {
    const m = pickMenu(models, { ...state, value: "haiku", roomDefault: "opus" });
    expect(m.items.filter((i) => i.isDefault).map((i) => i.pick)).toEqual(["opus"]);
    expect(m.items.filter((i) => i.selected).map((i) => i.pick)).toEqual(["haiku"]);
    expect(m.items[1]).toMatchObject({ label: "Sonnet 5.5", price: "$2 / $10" });
  });

  it("lets only an admin set a differing default", () => {
    expect(pickMenu(models, { ...state, value: "haiku", isAdmin: true }).canSetDefault).toBe(true);
    expect(pickMenu(models, { ...state, value: "haiku" }).canSetDefault).toBe(false);
    expect(pickMenu(models, { ...state, isAdmin: true }).canSetDefault).toBe(false);
  });
});

describe("nextEnabled", () => {
  const items = pickMenu(models, { ...state, taint: ["attachment"] }).items;
  it("skips disabled items and wraps", () => {
    expect(nextEnabled(items, 3, 1)).toBe(4);
    expect(nextEnabled(items, 4, 1)).toBe(0);
    expect(nextEnabled(items, 0, -1)).toBe(4);
  });
});

describe("labels", () => {
  it("pillLabel uses the short name on a phone", () => {
    expect(pillLabel(models, "deepseek-flash", true)).toBe("DS Flash");
    expect(pillLabel(models, "sonnet", false)).toBe("Sonnet 5.5");
  });

  it("modelLabel falls back to the id", () => {
    expect(modelLabel(models, "claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel(models, "x")).toBe("x");
  });
});

describe("footerText", () => {
  const a = { model: "claude-sonnet-5-5", pick: "auto", costMicros: 42_000, ms: 12_000 } as const;
  it("shows the routing for Auto", () => {
    expect(footerText(a, models)).toBe("Auto → Sonnet 5.5 · $0.04 · 0:12");
  });
  it("shows the model for a manual pick", () => {
    expect(footerText({ ...a, pick: "opus", model: "claude-opus-5-5" }, models)).toBe("Opus 5.5 · $0.04 · 0:12");
  });
  it("falls back to an unknown id", () => {
    expect(footerText({ ...a, pick: "opus", model: "x" }, models)).toBe("x · $0.04 · 0:12");
  });
});
