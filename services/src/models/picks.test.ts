import { describe, expect, it } from "vitest";
import { modelIdOf, parsePick, parseRoute, resolvePick, routerInput } from "./picks.js";

describe("parsePick", () => {
  it("accepts a known pick", () => expect(parsePick("opus", "aws")).toBe("opus"));
  it("treats a missing pick as none", () => {
    expect(parsePick(undefined, "aws")).toBeUndefined();
    expect(parsePick(null, "aws")).toBeUndefined();
  });
  it("rejects unknown picks", () => {
    expect(() => parsePick("gpt-5", "aws")).toThrow("Unknown model.");
    expect(() => parsePick("fake", "aws")).toThrow("Unknown model.");
  });
  it("allows fake locally", () => expect(parsePick("fake", "local")).toBe("fake"));
});

describe("resolvePick", () => {
  it("turns a DeepSeek default into Auto on a private thread", () =>
    expect(resolvePick(undefined, "deepseek-flash", ["attachment"])).toEqual({ pick: "auto", by: "default" }));
  it("uses the room default", () => expect(resolvePick(undefined, "opus", [])).toEqual({ pick: "opus", by: "default" }));
  it("prefers the sender's pick", () => expect(resolvePick("haiku", "opus", [])).toEqual({ pick: "haiku", by: "pick" }));
});

describe("modelIdOf", () => {
  it("maps a pick to its model id", () => expect(modelIdOf("deepseek-pro")).toBe("deepseek-v4-pro"));
});

describe("parseRoute", () => {
  it.each(["haiku", "Haiku.", "  haiku\n"])("sends %j to Haiku", (reply) =>
    expect(parseRoute(reply)).toBe("claude-haiku-5-5"),
  );
  it.each(["sonnet", "opus", "fable", "deepseek", "", "haiku or sonnet"])("sends %j to Sonnet", (reply) =>
    expect(parseRoute(reply)).toBe("claude-sonnet-5-5"),
  );
});

describe("routerInput", () => {
  it("caps the text at 4000 characters", () => expect(routerInput("x".repeat(5000))).toHaveLength(4000));
});
