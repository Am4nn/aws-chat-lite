import { afterEach, describe, expect, it, vi } from "vitest";
import { serverEnv } from "./env";

afterEach(() => vi.unstubAllEnvs());

describe("serverEnv", () => {
  it("dictates in the browser only when the stage says so", () => {
    vi.stubEnv("DICTATION", "browser");
    expect(serverEnv().dictation).toBe("browser");
    vi.stubEnv("DICTATION", "anything");
    expect(serverEnv().dictation).toBe("transcribe");
    vi.stubEnv("DICTATION", undefined);
    expect(serverEnv().dictation).toBe("transcribe");
  });
});
