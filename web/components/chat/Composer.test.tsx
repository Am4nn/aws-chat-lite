// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types";
import { Composer } from "./Composer";

const dictation = vi.hoisted(() => ({
  state: "idle" as string, elapsedMs: 0, live: { final: "", partial: "" }, error: undefined as string | undefined,
  start: vi.fn(async () => {}), stop: vi.fn(), cancel: vi.fn(), onText: null as unknown as (text: string) => void,
}));
vi.mock("./useDictation", () => ({
  MAX_DICTATION_MS: 60_000,
  useDictation: ({ onText }: { onText: (text: string) => void }) => { dictation.onText = onText; return dictation; },
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ roomId: "r1" }) }));
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ byId: () => undefined }) }));

afterEach(() => {
  cleanup();
  Object.assign(dictation, { state: "idle", elapsedMs: 0, live: { final: "", partial: "" }, error: undefined });
  vi.clearAllMocks();
});

function composer(mode: { kind: "reply"; message: Message } | null = null) {
  const props = { onSend: vi.fn(), onModeChange: vi.fn() };
  render(
    <Composer
      members={[]} meId="u1" mode={mode} onSaveEdit={() => {}} onEditLast={() => false} onTyping={() => {}} {...props}
    />,
  );
  return { ...props, box: screen.getByRole("combobox") as HTMLTextAreaElement };
}

describe("Composer dictation", () => {
  it("offers the mic, with its limit as the hint", () => {
    composer();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    expect(screen.getByRole("button", { name: "Dictate" }).title).toBe("Dictation · up to 1 minute");
    expect(dictation.start).toHaveBeenCalled();
  });

  it("puts the words in at the caret, spaced from the text around them", () => {
    const { box } = composer();
    fireEvent.change(box, { target: { value: "hello world", selectionStart: 5 } });
    act(() => dictation.onText("there"));
    expect(box.value).toBe("hello there world");
  });

  it("shows the time and the words while recording, and won't send until it ends", () => {
    Object.assign(dictation, { state: "recording", elapsedMs: 7400, live: { final: "this is", partial: "a te" } });
    const { box, onSend } = composer();
    fireEvent.change(box, { target: { value: "draft", selectionStart: 5 } });
    expect(screen.getByText("0:07 / 1:00")).toBeTruthy();
    expect(screen.getByText("this is").className).toContain("text-text");
    expect(screen.getByText("a te").className).toContain("text-text-2");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cancels on Escape, leaving a reply in place", () => {
    Object.assign(dictation, { state: "recording" });
    const message = { authorName: "bea", text: "hi" } as Message;
    const { box, onModeChange } = composer({ kind: "reply", message });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(dictation.cancel).toHaveBeenCalled();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("shows why it stopped", () => {
    Object.assign(dictation, { state: "error", error: "Microphone access is blocked. Allow it in the site settings to dictate." });
    composer();
    expect(screen.getByRole("alert").textContent).toBe("Microphone access is blocked. Allow it in the site settings to dictate.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dictation.cancel).toHaveBeenCalled();
  });
});
