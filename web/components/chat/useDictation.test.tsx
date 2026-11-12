// @vitest-environment jsdom
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DictationEngineProvider } from "./DictationEngine";
import { useDictation } from "./useDictation";

vi.mock("./useBrowserDictation", () => ({ useBrowserDictation: () => ({ engine: "browser" }) }));
vi.mock("./useTranscribeDictation", () => ({ useTranscribeDictation: () => ({ engine: "transcribe" }) }));

const inStage = (engine: "browser" | "transcribe") =>
  ({ children }: { children: ReactNode }) => <DictationEngineProvider engine={engine}>{children}</DictationEngineProvider>;
const engineFor = (wrapper?: ReturnType<typeof inStage>) =>
  renderHook(() => useDictation({ roomId: "r1", onText: vi.fn() }), { wrapper }).result.current.engine;

describe("useDictation", () => {
  it("dictates with the engine the stage chose", () => {
    expect(engineFor(inStage("browser"))).toBe("browser");
    expect(engineFor(inStage("transcribe"))).toBe("transcribe");
  });

  it("falls back to Transcribe outside a stage's provider", () => {
    expect(engineFor()).toBe("transcribe");
  });
});
