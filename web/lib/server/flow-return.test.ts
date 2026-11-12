import { describe, expect, it } from "vitest";
import { githubTarget, mcpTarget } from "./flow-return";

describe("mcpTarget", () => {
  it("returns to the room with the connected server's name", () => {
    expect(mcpTarget({ status: 200, body: { roomId: "r1", connection: { name: "test" } } })).toBe("/r/r1?mcp=test");
  });
  it("returns to the room with the error when the flow named one", () => {
    expect(mcpTarget({ status: 403, body: { roomId: "r1", error: "Finish connecting as the admin who started it." } }))
      .toBe("/r/r1?mcpError=Finish+connecting+as+the+admin+who+started+it.");
  });
  it("returns home with the error when the flow was unknown", () => {
    expect(mcpTarget({ status: 410, body: { error: "This connection attempt expired. Try again." } }))
      .toBe("/?mcpError=This+connection+attempt+expired.+Try+again.");
  });
});

describe("githubTarget", () => {
  it("returns to the room to pick repos", () => {
    expect(githubTarget({ status: 200, body: { roomId: "r1" } })).toBe("/r/r1?github=pick");
  });
  it("returns to the room with the error when the flow named one", () => {
    expect(githubTarget({ status: 403, body: { roomId: "r1", error: "Finish signing in as the admin who started it." } }))
      .toBe("/r/r1?githubError=Finish+signing+in+as+the+admin+who+started+it.");
  });
  it("returns home with the error when the flow was unknown", () => {
    expect(githubTarget({ status: 410, body: { error: "This GitHub sign-in expired. Try again." } }))
      .toBe("/?githubError=This+GitHub+sign-in+expired.+Try+again.");
    expect(githubTarget({ status: 500, body: {} })).toBe("/?githubError=Something+went+wrong.");
  });
});
