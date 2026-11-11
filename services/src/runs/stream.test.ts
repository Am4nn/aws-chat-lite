import { describe, it, expect } from "vitest";
import type { RunEvent, RunEventBody } from "../threads/types.js";
import { streamRun, type StreamDeps } from "./stream.js";

const at = "2026-11-11T00:00:00.000Z";
const finished: RunEventBody = { type: "run.finished", status: "done", ms: 10, steps: 0, costMicros: 0 };
const event = (seq: number, body: RunEventBody = { type: "text", text: `w${seq} ` }) => ({ ...body, seq, at }) as RunEvent;

/**
 * A run log on a fake clock: each event becomes visible at its `visibleAt` ms, `sleep` only moves the clock, and the
 * ticket "good" belongs to member u1 of room r1.
 */
function fakeRun(log: { event: RunEvent; visibleAt?: number }[], opts: { memberUntilMs?: number } = {}) {
  let now = 0;
  const deps: StreamDeps = {
    consume: async (ticket, runId) => (ticket === "good" && runId === "run1" ? { userId: "u1", roomId: "r1" } : null),
    events: async (_runId, after) => log.filter((l) => (l.visibleAt ?? 0) <= now && l.event.seq > after).map((l) => l.event),
    isMember: async () => now < (opts.memberUntilMs ?? Infinity),
    nowMs: () => now,
    sleep: async (ms) => { now += ms; },
  };
  return { deps, now: () => now };
}

/** A sink that records what streamRun wrote and when (on the fake clock). */
function recorder(now: () => number) {
  const out = { status: 0, writes: [] as { at: number; text: string }[], endedAt: -1 };
  return {
    out,
    sink: {
      status: (code: number) => { out.status = code; },
      write: (text: string) => { out.writes.push({ at: now(), text }); },
      end: () => { out.endedAt = now(); },
    },
  };
}

const ids = (writes: { text: string }[]) => writes.flatMap((w) => /^id: (\d+)/.exec(w.text)?.[1] ?? []);

describe("streamRun", () => {
  it("resumes after Last-Event-ID: events 4 and 5 only, then ends on run.finished", async () => {
    const log = [1, 2, 3, 4].map((seq) => ({ event: event(seq) })).concat({ event: event(5, finished) });
    const { deps, now } = fakeRun(log);
    const { out, sink } = recorder(now);
    await streamRun({ runId: "run1", ticket: "good", lastEventId: "3" }, sink, deps);
    expect(out.status).toBe(200);
    expect(ids(out.writes)).toEqual(["4", "5"]);
    expect(out.endedAt).toBe(0);
  });

  it("writes each event as one SSE frame: id, event name and the event as JSON", async () => {
    const e = event(4);
    const { deps, now } = fakeRun([{ event: e }, { event: event(5, finished) }]);
    const { out, sink } = recorder(now);
    await streamRun({ runId: "run1", ticket: "good", lastEventId: "3" }, sink, deps);
    expect(out.writes[0]!.text).toBe(`id: 4\nevent: run\ndata: ${JSON.stringify(e)}\n\n`);
  });

  it("treats a Last-Event-ID that isn't a whole number as 0", async () => {
    for (const lastEventId of ["-2", "x", "1.5", ""]) {
      const { deps, now } = fakeRun([{ event: event(1) }, { event: event(2, finished) }]);
      const { out, sink } = recorder(now);
      await streamRun({ runId: "run1", ticket: "good", lastEventId }, sink, deps);
      expect(ids(out.writes), lastEventId).toEqual(["1", "2"]);
    }
  });

  it("sends one keepalive comment after 15 s without an event", async () => {
    const { deps, now } = fakeRun([{ event: event(1) }, { event: event(2, finished), visibleAt: 20_000 }]);
    const { out, sink } = recorder(now);
    await streamRun({ runId: "run1", ticket: "good" }, sink, deps);
    expect(out.writes.map((w) => w.text.startsWith("id:") ? "frame" : w.text)).toEqual(["frame", ": ka\n\n", "frame"]);
    expect(out.writes[1]!.at).toBe(15_000);
  });

  it("a viewer removed from the room at 1 s loses the stream by the 30 s membership check", async () => {
    const { deps, now } = fakeRun([{ event: event(1) }], { memberUntilMs: 1000 });
    const { out, sink } = recorder(now);
    await streamRun({ runId: "run1", ticket: "good" }, sink, deps);
    expect(out.endedAt).toBeGreaterThanOrEqual(30_000);
    expect(out.endedAt).toBeLessThan(31_300);
    expect(ids(out.writes)).toEqual(["1"]);
  });

  it("ends at 14 minutes without run.finished, for the client to resume", async () => {
    const { deps, now } = fakeRun([{ event: event(1) }]);
    const { out, sink } = recorder(now);
    await streamRun({ runId: "run1", ticket: "good" }, sink, deps);
    expect(out.endedAt).toBe(14 * 60_000);
    expect(out.writes.filter((w) => w.text.includes("run.finished"))).toEqual([]);
  });

  it("stops polling when the client goes away", async () => {
    const { deps, now } = fakeRun([{ event: event(1) }]);
    const { out, sink } = recorder(now);
    const gone = new AbortController();
    const sleep = deps.sleep;
    deps.sleep = async (ms) => { await sleep(ms); if (now() >= 1000) gone.abort(); };
    await streamRun({ runId: "run1", ticket: "good", signal: gone.signal }, sink, deps);
    expect(out.endedAt).toBe(1000);
  });

  it("a bad ticket, or one for another run, is a 401 and nothing else", async () => {
    for (const req of [{ runId: "run1", ticket: "bad" }, { runId: "run2", ticket: "good" }]) {
      const { deps, now } = fakeRun([{ event: event(1, finished) }]);
      const { out, sink } = recorder(now);
      await streamRun(req, sink, deps);
      expect(out.status).toBe(401);
      expect(out.writes).toEqual([]);
      expect(out.endedAt).toBe(0);
    }
  });

  it("a drop mid-answer and a resume with Last-Event-ID show the answer exactly once", async () => {
    const words = ["The ", "answer ", "is ", "forty", "-two", "."];
    const log = words.map((text, i) => ({ event: event(i + 1, { type: "text", text }), visibleAt: i * 300 }))
      .concat({ event: event(words.length + 1, finished), visibleAt: 2000 });
    const { deps, now } = fakeRun(log);
    const seen: RunEvent[] = [];
    const parse = (text: string) => { const data = /\ndata: (.*)\n/.exec(text)?.[1]; if (data) seen.push(JSON.parse(data)); };

    // The first connection drops once three words have arrived.
    const drop = new AbortController();
    const first = recorder(now);
    await streamRun({ runId: "run1", ticket: "good", signal: drop.signal }, {
      ...first.sink, write: (text) => { parse(text); if (seen.length === 3) drop.abort(); },
    }, deps);
    expect(seen).toHaveLength(3);

    const second = recorder(now);
    await streamRun({ runId: "run1", ticket: "good", lastEventId: String(seen.at(-1)!.seq) }, {
      ...second.sink, write: parse,
    }, deps);

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const shown = seen.flatMap((e) => (e.type === "text" ? e.text : [])).join("");
    expect(shown).toBe(words.join(""));
  });
});
