import { describe, expect, it } from "vitest";
import { keepQuery } from "./keep-query";

describe("keepQuery", () => {
  it("carries the page's query onto the path it redirects to", () => {
    expect(keepQuery("/r/r1/c/c1", { mcpError: "It failed (x & y).", tag: ["a", "b"] }))
      .toBe("/r/r1/c/c1?mcpError=It+failed+%28x+%26+y%29.&tag=a&tag=b");
  });
  it("leaves the path alone when there is no query", () => expect(keepQuery("/r/r1", {})).toBe("/r/r1"));
});
