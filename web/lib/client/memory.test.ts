import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "../types";
import { sourceLine } from "./memory";

const now = Date.parse("2026-11-11T12:00:00Z");
const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  memoryId: "ab12cd34", text: "Deploys go out on Fridays.", private: false,
  source: { kind: "agent", agent: "reviewer", threadNumber: 12 },
  createdAt: "2026-11-11T10:00:00Z", updatedAt: "2026-11-11T10:00:00Z", updatedBy: "reviewer", ...over,
});

describe("sourceLine", () => {
  it("says which agent saved it, in which thread, and when", () => {
    expect(sourceLine(entry(), now)).toBe("@reviewer in #12 · 2 h ago");
  });
  it("says who edited it last, and when", () => {
    expect(sourceLine(entry({ updatedAt: "2026-11-11T11:55:00Z", updatedBy: "bea" }), now)).toBe("edited by bea · 5 min ago");
  });
  it("counts days and the last minute", () => {
    expect(sourceLine(entry({ createdAt: "2026-11-08T11:00:00Z", updatedAt: "2026-11-08T11:00:00Z" }), now)).toBe("@reviewer in #12 · 3 d ago");
    expect(sourceLine(entry({ createdAt: "2026-11-11T11:59:30Z", updatedAt: "2026-11-11T11:59:30Z" }), now)).toBe("@reviewer in #12 · just now");
  });
});
