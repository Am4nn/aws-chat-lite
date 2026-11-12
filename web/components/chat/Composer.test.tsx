// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types";
import { Composer } from "./Composer";

const dictation = vi.hoisted(() => ({
  state: "idle" as string, elapsedMs: 0, live: { final: "", partial: "" }, error: undefined as string | undefined,
  engine: "transcribe" as string, available: true, start: vi.fn(async () => {}), stop: vi.fn(), cancel: vi.fn(), onText: null as unknown as (text: string) => void,
}));
vi.mock("./useDictation", () => ({
  useDictation: ({ onText }: { onText: (text: string) => void }) => { dictation.onText = onText; return dictation; },
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ roomId: "r1" }) }));
vi.mock("@/lib/client/ThreadsProvider", () => ({ useThreads: () => ({ byId: () => undefined }) }));

afterEach(() => {
  cleanup();
  Object.assign(dictation, { state: "idle", elapsedMs: 0, live: { final: "", partial: "" }, error: undefined, engine: "transcribe", available: true });
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
  it("offers the mic, which says what it does", () => {
    composer();
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    expect(screen.getByRole("button", { name: "Dictate" }).title).toBe("Dictate · speak and it types");
    expect(dictation.start).toHaveBeenCalled();
  });

  it("hides the mic where the browser can't dictate", () => {
    Object.assign(dictation, { engine: "browser", available: false });
    composer();
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("has no hint beside the mic", () => {
    Object.assign(dictation, { engine: "browser" });
    composer();
    expect(screen.queryByRole("button", { name: /recognised by your browser/ })).toBeNull();
  });

  it("puts the words in at the caret, spaced from the text around them", () => {
    const { box } = composer();
    fireEvent.change(box, { target: { value: "hello world", selectionStart: 5 } });
    act(() => dictation.onText("there"));
    expect(box.value).toBe("hello there world");
  });

  it("types the words into the box as they're heard, with no strip or timer, and won't send until it ends", () => {
    Object.assign(dictation, { state: "recording", elapsedMs: 7400, live: { final: "this is", partial: "a te" } });
    const { box, onSend } = composer();
    fireEvent.change(box, { target: { value: "draft", selectionStart: 5 } });
    expect(box.value).toBe("draft this is a te");
    expect(box.readOnly).toBe(true);
    expect(screen.queryByText("0:07 / 1:00")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Stop dictating" })).toHaveLength(1);
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
    Object.assign(dictation, { state: "error", error: "Allow the microphone to dictate." });
    composer();
    expect(screen.getByRole("alert").textContent).toBe("Allow the microphone to dictate.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dictation.cancel).toHaveBeenCalled();
  });
});
