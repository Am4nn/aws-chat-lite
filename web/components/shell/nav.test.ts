import { describe, it, expect } from "vitest";
import { direction, nextRoomPath } from "./nav";

describe("direction (content enters from the way you moved)", () => {
  it("moving down the list comes in from below", () => expect(direction(1, 3)).toBe("down"));
  it("moving up comes in from above", () => expect(direction(3, 1)).toBe("up"));
  it("an unknown previous position counts as moving down", () => expect(direction(-1, 2)).toBe("down"));
});

describe("nextRoomPath (where to go after leaving or losing a room)", () => {
  const rooms = [{ roomId: "a" }, { roomId: "b" }];
  it("skips the room being left, even while the room list still shows it", () => expect(nextRoomPath(rooms, "a")).toBe("/r/b"));
  it("takes the first other room", () => expect(nextRoomPath(rooms, "x")).toBe("/r/a"));
  it("goes home when no other room is left", () => expect(nextRoomPath([{ roomId: "a" }], "a")).toBe("/"));
});
