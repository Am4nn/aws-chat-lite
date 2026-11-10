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
    openRunStream({ getUrl, onEvent: (e: RunEvent) => seen.push(e.seq), fetchImpl: fetchImpl as never, random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(getUrl).toHaveBeenCalledTimes(2);
    expect(calls[0].headers.get("last-event-id")).toBeNull();
    expect(calls[1].headers.get("last-event-id")).toBe("2");
    expect(seen).toEqual([1, 2, 3]);
  });

  it("stops after run.finished", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => body(frame(1, { type: "run.finished", status: "done", ms: 1, steps: 0, costMicros: 0 })));
    openRunStream({ getUrl: async () => "u", onEvent: () => {}, fetchImpl: fetchImpl as never });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after close()", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => hangingBody());
    const s = openRunStream({ getUrl: async () => "u", onEvent: () => {}, fetchImpl: fetchImpl as never });
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
    const s = openRunStream({ getUrl: async () => "u", onEvent: () => {}, fetchImpl: fetchImpl as never, random: () => 0.5 });
    await flush();
    s.drop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("reassembles a frame split across chunks", async () => {
    vi.useFakeTimers();
    const full = frame(1, { type: "text", text: "hello" });
    const fetchImpl = vi.fn(async () => body(full.slice(0, 20), full.slice(20)));
    const seen: number[] = [];
    openRunStream({ getUrl: async () => "u", onEvent: (e) => seen.push(e.seq), fetchImpl: fetchImpl as never });
    await flush();
    expect(seen).toEqual([1]);
  });

  it("reconnects after a fetch error", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(body(frame(1, { type: "run.finished", status: "done", ms: 1, steps: 0, costMicros: 0 })));
    const seen: number[] = [];
    openRunStream({ getUrl: async () => "u", onEvent: (e) => seen.push(e.seq), fetchImpl: fetchImpl as never, random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toEqual([1]);
  });

  it("redelivers an event whose handler threw", async () => {
    vi.useFakeTimers();
    const bodies = [() => body(frame(1, { type: "text", text: "a" })), () => body(frame(1, { type: "run.finished", status: "done", ms: 1, steps: 0, costMicros: 0 }))];
    const headers: (string | null)[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      headers.push(new Headers(init.headers).get("last-event-id"));
      return bodies[headers.length - 1]();
    });
    let first = true;
    openRunStream({ getUrl: async () => "u", onEvent: () => { if (first) { first = false; throw new Error("x"); } }, fetchImpl: fetchImpl as never, random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(headers).toEqual([null, null]);
  });

  it("delivers nothing after close()", async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    let handle: { close(): void };
    handle = openRunStream({ getUrl: async () => "u", onEvent: (e) => { seen.push(e.seq); handle.close(); }, fetchImpl: (async () => body(frame(1, { type: "text", text: "a" }), frame(2, { type: "text", text: "b" }))) as never });
    await flush();
    expect(seen).toEqual([1]);
  });

  it("stops and reports on a 4xx instead of reconnecting", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response("no", { status: 404 }));
    const onError = vi.fn();
    openRunStream({ getUrl: async () => "u", onEvent: () => {}, onError, fetchImpl: fetchImpl as never });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(404);
  });

  it("retries a 429 with backoff", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(body(frame(1, { type: "run.finished", status: "done", ms: 1, steps: 0, costMicros: 0 })));
    const onError = vi.fn();
    openRunStream({ getUrl: async () => "u", onEvent: () => {}, onError, fetchImpl: fetchImpl as never, random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
