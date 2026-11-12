// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserDictation } from "./useBrowserDictation";

type Result = { isFinal: boolean; 0: { transcript: string }; length: 1 };
const heard = (transcript: string, isFinal: boolean): Result => ({ isFinal, 0: { transcript }, length: 1 });

class FakeRecognition {
  static last: FakeRecognition;
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((e: { results: Result[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.end());
  abort = vi.fn(() => { this.onerror?.({ error: "aborted" }); this.end(); });
  constructor() { FakeRecognition.last = this; }
  begin() { act(() => this.onstart?.()); }
  hear(...results: Result[]) { act(() => this.onresult?.({ results })); }
  fail(error: string) { act(() => { this.onerror?.({ error }); this.end(); }); }
  end() { this.onend?.(); }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-IN");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function listening(onText = vi.fn()) {
  const hook = renderHook(() => useBrowserDictation({ onText }));
  act(() => void hook.result.current.start());
  expect(hook.result.current.state).toBe("starting");
  const rec = FakeRecognition.last;
  rec.begin();
  expect(hook.result.current.state).toBe("recording");
  return { ...hook, onText, rec };
}

describe("useBrowserDictation", () => {
  it("listens continuously in the browser's language, with the words so far, and lands them on Stop", () => {
    const { result, onText, rec } = listening();
    expect(rec).toMatchObject({ continuous: true, interimResults: true, lang: "en-IN" });
    expect(rec.start).toHaveBeenCalled();

    rec.hear(heard("this is", true), heard(" a te", false));
    expect(result.current.live).toEqual({ final: "this is", partial: "a te" });

    act(() => vi.advanceTimersByTime(7000));
    expect(result.current.elapsedMs).toBe(7000);
    act(() => result.current.stop());
    expect(rec.stop).toHaveBeenCalled();
    expect(onText).toHaveBeenCalledWith("this is a te");
    expect(result.current.state).toBe("idle");
  });

  it("stops by itself at a minute", () => {
    const { result, onText, rec } = listening();
    rec.hear(heard("almost", false));
    act(() => vi.advanceTimersByTime(60_000));
    expect(rec.stop).toHaveBeenCalled();
    expect(onText).toHaveBeenCalledWith("almost");
    expect(result.current.state).toBe("idle");
  });

  it("says it heard nothing when the browser ends a session with no words and no error", () => {
    const { result, onText, rec } = listening();
    act(() => rec.end());
    expect(onText).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ state: "error", error: "Didn't catch anything. Try again." });
  });

  it("cancels without keeping the words", () => {
    const { result, onText, rec } = listening();
    rec.hear(heard("never mind", false));
    act(() => result.current.cancel());
    expect(rec.abort).toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  it.each([
    ["not-allowed", "Allow the microphone to dictate."],
    ["service-not-allowed", "Allow the microphone to dictate."],
    ["no-speech", "Didn't catch anything. Try again."],
    ["network", "Dictation stopped. Try again."],
    ["audio-capture", "Dictation stopped. Try again."],
  ])("shows only an approved message for %s, keeping the words so far", (error, text) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, onText, rec } = listening();
    rec.hear(heard("so far", true));
    rec.fail(error);
    expect(result.current).toMatchObject({ state: "error", error: text });
    expect(onText).toHaveBeenCalledWith("so far");
    act(() => result.current.cancel());
    expect(result.current.state).toBe("idle");
  });

  it("is offered on the browser engine where the browser recognises speech", () => {
    const { result } = renderHook(() => useBrowserDictation({ onText: vi.fn() }));
    expect(result.current).toMatchObject({ engine: "browser", available: true });
  });

  it("isn't offered where the browser has no speech recognition, as in Firefox", () => {
    vi.unstubAllGlobals();
    const { result } = renderHook(() => useBrowserDictation({ onText: vi.fn() }));
    expect(result.current.available).toBe(false);
  });

  it("stops listening when the composer goes away", () => {
    const { unmount, onText, rec } = listening();
    rec.hear(heard("gone", false));
    unmount();
    expect(rec.abort).toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });
});
