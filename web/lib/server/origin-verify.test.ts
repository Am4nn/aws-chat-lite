import { describe, it, expect } from "vitest";
import { originVerified } from "./origin-verify";

describe("originVerified (only CloudFront knows the secret)", () => {
  it("accepts the right secret", () => {
    expect(originVerified("s3cret", "s3cret")).toBe(true);
  });
  it("rejects a missing, wrong or different-length secret", () => {
    expect(originVerified(null, "s3cret")).toBe(false);
    expect(originVerified("s3creT", "s3cret")).toBe(false);
    expect(originVerified("s3cre", "s3cret")).toBe(false);
    expect(originVerified("s3crets", "s3cret")).toBe(false);
  });
  it("is off when no secret is configured (next dev)", () => {
    expect(originVerified(null, undefined)).toBe(true);
    expect(originVerified(null, "")).toBe(true);
  });
});
