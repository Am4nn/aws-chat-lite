// @vitest-environment jsdom
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bff } from "@/lib/client/bff";
import { useDictation } from "./useDictation";

vi.mock("@/lib/client/bff", () => ({ bff: vi.fn(), errorText: (e: Error) => e.message }));

const codec = new EventStreamCodec(toUtf8, fromUtf8);
const serverFrame = (type: "event" | "exception", body: unknown) => codec.encode({
  headers: { ":message-type": { type: "string", value: type } },
  body: fromUtf8(JSON.stringify(body)),
});
const words = (Transcript: string, IsPartial: boolean) =>
  serverFrame("event", { Transcript: { Results: [{ IsPartial, Alternatives: [{ Transcript }] }] } });

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 0;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  constructor(public url: string) {
    super();
    FakeSocket.last = this;
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(bytes: Uint8Array) { this.sent.push(bytes); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  receive(bytes: Uint8Array) {
    act(() => { this.dispatchEvent(new MessageEvent("message", { data: bytes.slice().buffer })); });
  }
}

class FakeWorkletNode {
  static last: FakeWorkletNode;
  port = { onmessage: null as ((e: { data: Float32Array }) => void) | null };
  connect = vi.fn();
  constructor() { FakeWorkletNode.last = this; }
}

const track = { stop: vi.fn() };
const contexts: { close: ReturnType<typeof vi.fn> }[] = [];
class FakeAudioContext {
  sampleRate = 48000;
  state = "running";
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = () => ({ connect: vi.fn() });
  close = vi.fn(async () => { this.state = "closed"; });
  constructor() { contexts.push(this); }
}

const getUserMedia = vi.fn();
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const sentKind = (bytes: Uint8Array) => codec.decode(bytes).body.length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  getUserMedia.mockResolvedValue({ getTracks: () => [track] });
  vi.mocked(bff).mockImplementation(async (path: string) =>
    path.endsWith("/sessions") ? { sessionId: "s1", url: "wss://transcribe.test/x", maxSeconds: 60, sampleRate: 16000 } : { billedSeconds: 15 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  contexts.length = 0;
});

async function recording(onText = vi.fn()) {
  const hook = renderHook(() => useDictation({ roomId: "r1", onText }));
  await act(() => hook.result.current.start());
  expect(hook.result.current.state).toBe("recording");
  return { ...hook, onText, socket: FakeSocket.last };
}

const doneCalls = () => vi.mocked(bff).mock.calls.filter(([path]) => path.endsWith("/done"));

describe("useDictation", () => {
  it("streams the mic as 100 ms audio events and lands the final words", async () => {
    const { result, onText, socket } = await recording();
    expect(bff).toHaveBeenCalledWith("/bff/api/rooms/r1/voice/sessions", { body: {} });
    expect(socket.url).toBe("wss://transcribe.test/x");
    expect(socket.binaryType).toBe("arraybuffer");

    act(() => FakeWorkletNode.last.port.onmessage!({ data: new Float32Array(4800) }));
    expect(socket.sent.map(sentKind)).toEqual([3200]);

    socket.receive(words("this", true));
    expect(result.current.live).toEqual({ final: "", partial: "this" });

    vi.setSystemTime(Date.now() + 7000);
    act(() => result.current.stop());
    expect(result.current.state).toBe("finishing");
    expect(sentKind(socket.sent.at(-1)!)).toBe(0);
    socket.receive(words("this is", false));
    act(() => socket.close());
    await flush();

    expect(onText).toHaveBeenCalledWith("this is");
    expect(doneCalls()).toEqual([["/bff/api/rooms/r1/voice/sessions/s1/done", { body: { seconds: 7 } }]]);
    expect(result.current.state).toBe("idle");
    expect(track.stop).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
  });

  it("stops by itself at a minute and waits at most 3 s for the last words", async () => {
    const { result, onText, socket } = await recording();
    socket.receive(words("almost", true));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(result.current.state).toBe("finishing");
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(result.current.state).toBe("idle");
    expect(onText).toHaveBeenCalledWith("almost");
    expect(doneCalls()[0][1]).toEqual({ body: { seconds: 60 } });
  });

  it("cancels without keeping the words, still reporting the time", async () => {
    const { result, onText, socket } = await recording();
    socket.receive(words("never mind", true));
    act(() => result.current.cancel());
    await flush();
    expect(onText).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
    expect(doneCalls()).toHaveLength(1);
    expect(result.current.state).toBe("idle");
  });

  it("explains a blocked mic and never mints a session", async () => {
    getUserMedia.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    const { result } = renderHook(() => useDictation({ roomId: "r1", onText: vi.fn() }));
    await act(() => result.current.start());
    expect(result.current).toMatchObject({ state: "error", error: "Microphone access is blocked. Allow it in the site settings to dictate." });
    expect(bff).not.toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
    act(() => result.current.cancel());
    expect(result.current.state).toBe("idle");
  });

  it("stops on a transcriber error, keeping the words so far", async () => {
    const { result, onText, socket } = await recording();
    socket.receive(words("this", true));
    socket.receive(serverFrame("exception", { Message: "Your request timed out." }));
    await flush();
    expect(result.current).toMatchObject({ state: "error", error: "Dictation stopped: Your request timed out." });
    expect(onText).toHaveBeenCalledWith("this");
    expect(doneCalls()).toHaveLength(1);
  });

  it("stops when the connection drops", async () => {
    const { result, socket } = await recording();
    act(() => socket.close());
    await flush();
    expect(result.current).toMatchObject({ state: "error", error: "Dictation stopped: the connection closed." });
  });
});
