import { describe, it, expect } from "vitest";
import { staleStacks } from "./stale.js";

const ok = (name: string) => ({ name, status: "CREATE_COMPLETE" });

describe("staleStacks (after floci reset, stack records outlive their resources)", () => {
  it("returns our stacks + CDKToolkit when the bootstrap param is gone", () => {
    expect(staleStacks([ok("CDKToolkit"), ok("cl-local-core"), ok("someone-else")], false))
      .toEqual(["cl-local-core", "CDKToolkit"]);
  });

  it("returns nothing when the bootstrap param still exists", () => {
    expect(staleStacks([ok("CDKToolkit"), ok("cl-local-core")], true)).toEqual([]);
  });

  it("returns our DELETE_FAILED stacks even when bootstrap is fine (deploy would say 'no changes')", () => {
    expect(staleStacks([ok("CDKToolkit"), { name: "cl-local-core", status: "DELETE_FAILED" }], true))
      .toEqual(["cl-local-core"]);
  });

  it("never touches other people's stacks", () => {
    expect(staleStacks([{ name: "other", status: "DELETE_FAILED" }], false)).toEqual([]);
  });
});
