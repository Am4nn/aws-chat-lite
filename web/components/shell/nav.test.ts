import { describe, it, expect } from "vitest";
import { direction } from "./nav";

describe("direction (content enters from the way you moved)", () => {
  it("moving down the list comes in from below", () => expect(direction(1, 3)).toBe("down"));
  it("moving up comes in from above", () => expect(direction(3, 1)).toBe("up"));
  it("an unknown previous position counts as moving down", () => expect(direction(-1, 2)).toBe("down"));
});
