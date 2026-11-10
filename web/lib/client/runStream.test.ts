import { describe, expect, it, vi, afterEach } from "vitest";
import { openRunStream } from "./runStream";
import type { RunEvent } from "../types";

afterEach(() => vi.useRealTimers());

const frame = (seq: number, body: object) => `id: ${seq}\nevent: run\ndata: ${JSON.stringify({ seq, at: "t", ...body })}\n\n`;
const body = (...chunks: string[]) =>
  new Response(new ReadableStream({ start(c) { chunks.forEach((s) => c.enqueue(new TextEncoder().encode(s))); c.close(); } }));
const hangingBody = () => new Response(new ReadableStream({ start() {} }));
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("openRunStream", () => {
  it("resumes from the last seq with a fresh url", async () => {
    vi.useFakeTimers();
    const calls: { url: string; headers: Headers }[] = [];
    const bodies = [
      () => body(frame(1, { type: "text", text: "a" }), frame(2, { type: "text", text: "b" })),
      () => body(frame(3, { type: "run.finished", status: "done", ms: 1, steps: 0, costMicros: 0 })),
    ];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return bodies[calls.length - 1]();
    });
    const getUrl = vi.fn(async () => `u${calls.length}`);
    const seen: number[] = [];
    openRunStream({ runId: "r", getUrl, onEvent: (e: RunEvent) => seen.push(e.seq), fetchImpl: fetchImpl as never, random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(getUrl).toHaveBeenCalledTimes(2);
    expect(calls[0].headers.get("last-event-id")).toBeNull();
    expect(calls[1].headers.get("last-event-id")).toBe("2");
    expect(seen).toEqual([1, 2, 3]);
  });

  it("stops after run.finished", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => body(frame(1, { type: "run.finished", status: "done", ms: 1, steps: 0, costMicros: 0 })));
    openRunStream({ runId: "r", getUrl: async () => "u", onEvent: () => {}, fetchImpl: fetchImpl as never });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after close()", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => hangingBody());
    const s = openRunStream({ runId: "r", getUrl: async () => "u", onEvent: () => {}, fetchImpl: fetchImpl as never });
    await flush();
    s.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drop() aborts the request and reconnects", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const r = new Response(new ReadableStream({ start(c) { init.signal?.addEventListener("abort", () => c.error(new Error("aborted"))); } }));
      return r;
    });
    const s = openRunStream({ runId: "r", getUrl: async () => "u", onEvent: () => {}, fetchImpl: fetchImpl as never, random: () => 0.5 });
    await flush();
    s.drop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
