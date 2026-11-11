import { describe, expect, it } from "vitest";
import { applyResults, transcriptText } from "./transcript";

const result = (Transcript: string, IsPartial: boolean) => ({ IsPartial, Alternatives: [{ Transcript }] });

describe("applyResults", () => {
  it("lets each partial replace the last and a final settle it", () => {
    let s = { final: "", partial: "" };
    s = applyResults(s, [result("this", true)]);
    s = applyResults(s, [result("this is", true)]);
    expect(s).toEqual({ final: "", partial: "this is" });
    s = applyResults(s, [result("this is", false)]);
    expect(s).toEqual({ final: "this is", partial: "" });
    expect(transcriptText(s)).toBe("this is");
  });

  it("appends each final to the ones before it", () => {
    const s = applyResults({ final: "one.", partial: "tw" }, [result("Two.", false), result("thr", true)]);
    expect(s).toEqual({ final: "one. Two.", partial: "thr" });
    expect(transcriptText(s)).toBe("one. Two. thr");
  });
});
