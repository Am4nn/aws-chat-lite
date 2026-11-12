import { describe, expect, it } from "vitest";
import { missingObject } from "./s3.js";

/** What the SDK throws for a HEAD, which has no body: only the status says what happened. */
const headError = (name: string, status: number) => Object.assign(new Error("UnknownError"), { name, $metadata: { httpStatusCode: status } });

describe("missingObject", () => {
  it("reads a 403 or 404 on a HEAD as no such object, whatever name the SDK gives it", () => {
    expect(missingObject(headError("NotFound", 404))).toBe(true);
    expect(missingObject(headError("Forbidden", 403))).toBe(true);
    // The Lambda runtime's newer SDK names a bodiless 403 "Unknown".
    expect(missingObject(headError("Unknown", 403))).toBe(true);
  });

  it("lets any other failure through", () => {
    expect(missingObject(headError("Unknown", 500))).toBe(false);
    expect(missingObject(new Error("socket hang up"))).toBe(false);
  });
});
