import { describe, it, expect } from "vitest";
import { isCreator } from "./claims.js";

describe("isCreator (the cognito:groups claim comes in several shapes)", () => {
  it("accepts an array", () => expect(isCreator({ "cognito:groups": ["creators"] })).toBe(true));
  it("accepts API Gateway's bracketed string", () => expect(isCreator({ "cognito:groups": "[creators admins]" })).toBe(true));
  it("accepts a JSON-encoded array string", () => expect(isCreator({ "cognito:groups": '["admins","creators"]' })).toBe(true));
  it("accepts a bare string", () => expect(isCreator({ "cognito:groups": "creators" })).toBe(true));
  it("rejects missing claims", () => expect(isCreator({})).toBe(false));
  it("rejects look-alike groups", () => expect(isCreator({ "cognito:groups": ["creatorsX"] })).toBe(false));
});
