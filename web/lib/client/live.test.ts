import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, LiveSocket } from "./live";

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.onclose?.(); }
  open() { this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

let tickets = 0;
const make = () => new LiveSocket({
  getTicket: async () => ({ ticket: `t${++tickets}`, url: "wss://x/live" }),
  WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
});

beforeEach(() => { vi.useFakeTimers(); FakeSocket.all = []; tickets = 0; });
afterEach(() => vi.useRealTimers());

describe("backoffMs", () => {
  it("doubles with a cap and ±20% jitter", () => {
    expect(backoffMs(0, () => 0.5)).toBe(1000);
    expect(backoffMs(10, () => 0.5)).toBe(30000);
    expect(backoffMs(1, () => 0)).toBe(1600);
  });
});

describe("LiveSocket", () => {
  const openSocket = async () => {
    const live = make();
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0].open();
    return live;
  };

  it("resolves a request on its ack and rejects on ok:false", async () => {
    const live = await openSocket();
    const ws = FakeSocket.all[0];
    const good = live.request("edit", { seq: 1 });
    ws.receive({ type: "ack", requestId: ws.sent[0].requestId, ok: true, data: 7 });
    await expect(good).resolves.toBe(7);
    const bad = live.request("edit", { seq: 1 });
    ws.receive({ type: "ack", requestId: ws.sent[1].requestId, ok: false, error: "forbidden" });
    await expect(bad).rejects.toThrow("forbidden");
  });

  it("rejects after 10 seconds without an ack", async () => {
    const live = await openSocket();
    const assertion = expect(live.request("edit", {})).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("says connecting until the first open and reconnecting after a drop", async () => {
    const live = make();
    live.start();
    expect(live.status).toBe("connecting");
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0].open();
    expect(live.status).toBe("open");
    FakeSocket.all[0].close();
    expect(live.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(live.status).toBe("reconnecting");
  });

  it("reconnects with a fresh ticket and emits reconnected", async () => {
    const live = await openSocket();
    const onReconnected = vi.fn();
    live.on("reconnected", onReconnected);
    FakeSocket.all[0].close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1].url).toContain("t2");
    FakeSocket.all[1].open();
    expect(onReconnected).toHaveBeenCalledWith({ type: "reconnected" });
  });

  it("pings every 4 minutes while open", async () => {
    await openSocket();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(FakeSocket.all[0].sent.map((f) => f.action)).toEqual(["ping"]);
  });

  it("rejects pending requests when the socket closes", async () => {
    const live = await openSocket();
    const p = live.request("edit", {});
    FakeSocket.all[0].close();
    await expect(p).rejects.toThrow("connection closed");
  });
});

describe("LiveSocket lifecycle", () => {
  it("stops retrying after stop() when the ticket fetch fails", async () => {
    let fail: (e: Error) => void = () => {};
    const getTicket = vi.fn(() => new Promise<{ ticket: string; url: string }>((_, reject) => { fail = reject; }));
    const live = new LiveSocket({ getTicket, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
    live.start();
    live.stop();
    fail(new Error("down"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(live.status).toBe("closed");
  });

  it("opens exactly one socket after stop() then start() while a ticket is pending", async () => {
    const resolvers: ((t: { ticket: string; url: string }) => void)[] = [];
    const getTicket = () => new Promise<{ ticket: string; url: string }>((r) => resolvers.push(r));
    const live = new LiveSocket({ getTicket, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
    live.start();
    live.stop();
    live.start();
    resolvers.forEach((r, i) => r({ ticket: `t${i}`, url: "wss://x/live" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("ignores a stale socket closing after restart", async () => {
    const live = make();
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    const stale = FakeSocket.all[0];
    stale.open();
    live.stop();
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    const fresh = FakeSocket.all[1];
    fresh.open();
    const rejected = vi.fn();
    live.request("edit", {}).catch(rejected);
    stale.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rejected).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(2);
    expect(live.status).toBe("open");
  });
});
