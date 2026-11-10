import { describe, expect, it } from "vitest";
import { pickAnchor } from "./scrollAnchor";

describe("pickAnchor", () => {
  const rows = [{ key: "a", top: -80, bottom: -10 }, { key: "b", top: -10, bottom: 40 }, { key: "c", top: 40, bottom: 90 }];
  it("anchors on the first row still showing at the top of the viewport, with its offset", () => {
    expect(pickAnchor(rows, 0)).toEqual({ key: "b", top: -10 });
  });
  it("gives nothing when no row reaches the viewport", () => {
    expect(pickAnchor(rows, 100)).toBeUndefined();
  });
});
