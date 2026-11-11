import { describe, expect, it } from "vitest";
import { ValidationError } from "../lib/errors.js";
import { conflictCopy, deniedResult, expiredResult, formatWait, SKIP_NOTE, timeoutMinutes, unsure } from "./model.js";

describe("formatWait", () => {
  it("says hours, minutes or under a minute", () => {
    expect(formatWait(7200)).toBe("2 h");
    expect(formatWait(2700)).toBe("45 min");
    expect(formatWait(30)).toBe("under a minute");
  });
  it("keeps the minutes past a whole hour", () => expect(formatWait(5400)).toBe("1 h 30 min"));
});

describe("timeoutMinutes", () => {
  it("takes whole minutes from 5 to 1440", () => {
    expect(timeoutMinutes(120)).toBe(120);
    expect(timeoutMinutes(5)).toBe(5);
    expect(timeoutMinutes(1440)).toBe(1440);
  });
  it("refuses anything else", () => {
    for (const raw of [4, 1441, "x", 10.5, undefined]) {
      expect(() => timeoutMinutes(raw)).toThrow(new ValidationError("The approval timeout is 5 to 1440 minutes."));
    }
  });
});

describe("copy", () => {
  it("tells the model what happened", () => {
    expect(deniedResult("bea")).toBe("Denied by bea. Don't try this again unless someone asks.");
    expect(expiredResult(7200)).toBe("Skipped: no one approved this within 2 h.");
    expect(unsure("GitHub")).toBe(
      "This write may or may not have happened (the step was interrupted). Check GitHub before trying again.",
    );
    expect(unsure("test")).toBe("This write may or may not have happened (the step was interrupted). Check test before trying again.");
    expect(SKIP_NOTE("Comment on #1 in a/b?")).toBe("\n\n(Skipped because no one approved in time: Comment on #1 in a/b?)");
  });

  it("names who decided first, or why no one can", () => {
    expect(conflictCopy({ status: "approved", by: "aman" })).toBe("Already approved by aman.");
    expect(conflictCopy({ status: "denied", by: "bea" })).toBe("Already denied by bea.");
    expect(conflictCopy({ status: "expired" })).toBe("This approval expired.");
    expect(conflictCopy({ status: "pending" })).toBe("This approval expired.");
    expect(conflictCopy({ status: "cancelled" })).toBe("This run was stopped.");
  });
});
