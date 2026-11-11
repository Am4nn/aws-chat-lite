import { describe, it, expect } from "vitest";
import { ValidationError } from "../lib/errors.js";
import { roomName, chatName } from "./model.js";

describe("chatName", () => {
  it("lowercases and trims", () => expect(chatName(" General ")).toBe("general"));
  it("allows a-z, 0-9 and dashes up to 32", () => expect(chatName("deploys-2026")).toBe("deploys-2026"));
  it("rejects spaces, empty, too long and non-strings", () => {
    for (const bad of ["a b", "", "   ", "x".repeat(33), "Ünïcode", 42, null]) {
      expect(() => chatName(bad)).toThrow(ValidationError);
    }
  });
});

describe("roomName", () => {
  it("trims and keeps case", () => expect(roomName("  Dev Team ")).toBe("Dev Team"));
  it("rejects empty and over 40 chars", () => {
    expect(() => roomName("")).toThrow(ValidationError);
    expect(() => roomName("x".repeat(41))).toThrow(ValidationError);
    expect(() => roomName(undefined)).toThrow(ValidationError);
  });
});
