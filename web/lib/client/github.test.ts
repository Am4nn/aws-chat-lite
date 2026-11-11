import { describe, expect, it } from "vitest";
import { githubCallbackTarget } from "./github";

describe("githubCallbackTarget", () => {
  it("returns to the room to pick repos", () => {
    expect(githubCallbackTarget({ status: 200, body: { roomId: "r1" } })).toBe("/r/r1?github=pick");
  });
  it("returns to the room with the error when the flow named one", () => {
    expect(githubCallbackTarget({ status: 403, body: { roomId: "r1", error: "Finish signing in as the admin who started it." } }))
      .toBe("/r/r1?githubError=Finish+signing+in+as+the+admin+who+started+it.");
  });
  it("returns home with the error when the flow was unknown", () => {
    expect(githubCallbackTarget({ status: 410, body: { error: "This GitHub sign-in expired. Try again." } }))
      .toBe("/?githubError=This+GitHub+sign-in+expired.+Try+again.");
    expect(githubCallbackTarget({ status: 500, body: {} })).toBe("/?githubError=Something+went+wrong.");
  });
});
