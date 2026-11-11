// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { markFlowStarted, takeFlowMark } from "./flow-return";

describe("takeFlowMark", () => {
  afterEach(() => sessionStorage.clear());

  it("is true once for a sign-in this tab started", () => {
    markFlowStarted();
    expect(takeFlowMark()).toBe(true);
    expect(takeFlowMark()).toBe(false);
  });

  it("is false in a tab that started none, so a crafted ?mcpError= or ?githubError= can't speak for chat-lite", () => {
    expect(takeFlowMark()).toBe(false);
  });
});
