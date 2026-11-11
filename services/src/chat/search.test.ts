import { describe, it, expect } from "vitest";
import { normalizeQuery } from "./search.js";
import { ValidationError } from "../lib/errors.js";

describe("normalizeQuery", () => {
  it("trims and lowercases, to match the stored textLower", () => {
    expect(normalizeQuery(" Hi ")).toBe("hi");
  });

  it("needs at least 2 characters", () => {
    expect(() => normalizeQuery("a")).toThrow(ValidationError);
    expect(() => normalizeQuery(" a ")).toThrow(ValidationError);
    expect(() => normalizeQuery(undefined)).toThrow(ValidationError);
  });
});
