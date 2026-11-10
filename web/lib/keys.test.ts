import { describe, it, expect } from "vitest";
import { isPaletteShortcut } from "./keys";

const key = (o: { key?: string; ctrlKey?: boolean; metaKey?: boolean; tag?: string; palette?: boolean }) => ({
  key: o.key ?? "k",
  ctrlKey: !!o.ctrlKey,
  metaKey: !!o.metaKey,
  target: { tagName: o.tag ?? "BODY", closest: (sel: string) => (o.palette && sel === "[cmdk-root]" ? {} : null) },
});

describe("isPaletteShortcut", () => {
  it("Ctrl K and Cmd K open the palette", () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true, key: "K" }))).toBe(true);
  });
  it("K alone does nothing", () => expect(isPaletteShortcut(key({}))).toBe(false));
  it("is ignored while typing in another field, but works inside the palette", () => {
    expect(isPaletteShortcut(key({ ctrlKey: true, tag: "TEXTAREA" }))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, tag: "INPUT" }))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, tag: "INPUT", palette: true }))).toBe(true);
  });
});
