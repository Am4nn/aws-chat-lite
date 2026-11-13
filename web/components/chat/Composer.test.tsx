// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/lib/types";
import { RoomTagsContext, type RoomTags } from "@/lib/client/roomTags";
import { Composer, type ComposerHandle, type ComposerMode } from "./Composer";

const dictation = vi.hoisted(() => ({
  state: "idle" as string, elapsedMs: 0, live: { final: "", partial: "" }, error: undefined as string | undefined,
  engine: "transcribe" as string, available: true, start: vi.fn(async () => {}), stop: vi.fn(), cancel: vi.fn(), onText: null as unknown as (text: string) => void,
}));
vi.mock("./useDictation", () => ({
  useDictation: ({ onText }: { onText: (text: string) => void }) => { dictation.onText = onText; return dictation; },
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ roomId: "r1" }) }));

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

describe("Composer tag insert", () => {
  function tagged(mode: ComposerMode = null) {
    const handle = createRef<ComposerHandle>();
    const onModeChange = vi.fn();
    render(<Composer ref={handle} members={[]} meId="u1" mode={mode} onModeChange={onModeChange} onSend={() => {}} onSaveEdit={() => {}} onTyping={() => {}} />);
    const box = screen.getByRole("combobox") as HTMLTextAreaElement;
    return { box, onModeChange, insert: (tag: string) => act(() => handle.current!.insertTag(tag)) };
  }

  it("puts the tag and a space in an empty box, focused with the caret after it", () => {
    const { box, insert } = tagged();
    insert("#pr-review");
    expect(box.value).toBe("#pr-review ");
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(11);
  });

  it("goes in at the caret, spaced from the text around it", () => {
    const { box, insert } = tagged();
    fireEvent.change(box, { target: { value: "please check", selectionStart: 0 } });
    insert("#pr-review");
    expect(box.value).toBe("#pr-review please check");
    fireEvent.change(box, { target: { value: "hi", selectionStart: 2 } });
    insert("#docs");
    expect(box.value).toBe("hi #docs ");
  });

  it("ends a quote reply, since the message now goes to the thread", () => {
    const { onModeChange, insert } = tagged({ kind: "reply", message: { authorName: "bea", text: "hi" } as Message });
    insert("#pr-review");
    expect(onModeChange).toHaveBeenCalledWith(null);
  });
});

describe("Composer thread tags", () => {
  const tags: RoomTags = { roomId: "r1", threads: [{ number: 1, name: "pr-check" }], chats: [] };
  const inChannel = (routesTags: boolean) => {
    render(
      <RoomTagsContext value={tags}>
        <Composer members={[]} meId="u1" routesTags={routesTags} onSend={() => {}} onSaveEdit={() => {}} onTyping={() => {}} />
      </RoomTagsContext>,
    );
    const box = screen.getByRole("combobox");
    const send = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    return { type: (text: string) => fireEvent.change(box, { target: { value: text } }), send };
  };

  it("won't send a channel message that only tags a thread, and says what's missing", () => {
    const { type, send } = inChannel(true);
    type("#pr-check ");
    expect(send().disabled).toBe(true);
    expect(send().title).toBe("Add a message after the tag");
    type("#pr-check what changed?");
    expect(send().disabled).toBe(false);
  });

  it("sends a bare tag where it doesn't route, as in a thread", () => {
    const { type, send } = inChannel(false);
    type("#pr-check");
    expect(send().disabled).toBe(false);
  });
});
