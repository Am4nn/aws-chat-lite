import type { LiveEvent } from "../types";
import { DEFAULT_ERROR, UserError } from "./errors";

// Only a request refused before it went out is certainly not sent: one that got no ack may have been stored.
const NOT_SENT = "Not connected, so nothing was sent.";
const UNCONFIRMED = "The server didn't confirm it. Check before retrying.";

export type ClientEvent = LiveEvent | { type: "reconnected" };
type Status = "connecting" | "open" | "reconnecting" | "closed";
type Ticket = { ticket: string; url: string };
type Pending = { resolve: (data: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const ACK_TIMEOUT_MS = 10_000;
// API Gateway drops idle sockets at 10 minutes.
const PING_EVERY_MS = 4 * 60_000;

export const backoffMs = (attempt: number, random: () => number) =>
  Math.min(30_000, 1000 * 2 ** attempt) * (0.8 + 0.4 * random());

export class LiveSocket {
  status: Status = "closed";
  private ws?: WebSocket;
  private attempt = 0;
  private everOpened = false;
  private wanted = false;
  private generation = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private handlers = new Map<string, Set<(e: never) => void>>();
  private statusHandlers = new Set<(s: Status) => void>();

  constructor(private opts: { getTicket: () => Promise<Ticket>; WebSocketImpl?: typeof WebSocket }) {}

  start() {
    if (this.wanted) return;
    this.wanted = true;
    void this.connect(this.generation);
  }

  stop() {
    this.wanted = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    this.dropSocket();
    this.setStatus("closed");
  }

  request(action: string, args: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (this.status !== "open" || !ws) return Promise.reject(new UserError(NOT_SENT));
    const requestId = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new UserError(UNCONFIRMED));
      }, ACK_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ action, requestId, ...args }));
    });
  }

  // An intersection, not Extract: message.new and message.updated share one member, which Extract would drop.
  on<T extends ClientEvent["type"]>(type: T, fn: (e: ClientEvent & { type: T }) => void): () => void {
    const set = this.handlers.get(type) ?? new Set();
    this.handlers.set(type, set);
    set.add(fn as (e: never) => void);
    return () => set.delete(fn as (e: never) => void);
  }

  onStatus(fn: (s: Status) => void): () => void {
    this.statusHandlers.add(fn);
    return () => this.statusHandlers.delete(fn);
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    this.statusHandlers.forEach((fn) => fn(s));
  }

  private emit(e: ClientEvent) {
    this.handlers.get(e.type)?.forEach((fn) => fn(e as never));
  }

  // A stop() or restart bumps the generation, so a connect still awaiting its ticket must not open a socket.
  private async connect(gen: number) {
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    let ticket: Ticket;
    try {
      ticket = await this.opts.getTicket();
    } catch {
      if (gen === this.generation) this.scheduleReconnect(gen);
      return;
    }
    if (gen !== this.generation) return;
    const ws = new (this.opts.WebSocketImpl ?? WebSocket)(`${ticket.url}?ticket=${encodeURIComponent(ticket.ticket)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.everOpened = true;
      this.setStatus("open");
      // The server answers a ping with a pong, not an ack, so nothing waits on it.
      this.pingTimer = setInterval(() => ws.send(JSON.stringify({ action: "ping" })), PING_EVERY_MS);
      this.emit({ type: "reconnected" });
    };
    ws.onmessage = (e) => {
      let frame;
      try {
        frame = JSON.parse(String(e.data));
      } catch {
        return; // Not JSON, so no event or ack the client could act on.
      }
      this.receive(frame);
    };
    ws.onclose = () => {
      this.failPending();
      if (gen === this.generation) this.scheduleReconnect(gen);
    };
  }

  private dropSocket() {
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close();
    }
    this.failPending();
  }

  private failPending() {
    clearInterval(this.pingTimer);
    this.pending.forEach((p, id) => {
      clearTimeout(p.timer);
      p.reject(new UserError(UNCONFIRMED));
      this.pending.delete(id);
    });
  }

  private scheduleReconnect(gen: number) {
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    this.retryTimer = setTimeout(() => void this.connect(gen), backoffMs(this.attempt++, Math.random));
  }

  private receive(frame: LiveEvent | { type: "ack"; requestId: string; ok: boolean; data?: unknown; error?: string }) {
    if (frame.type !== "ack") return this.emit(frame);
    const p = this.pending.get(frame.requestId);
    if (!p) return;
    this.pending.delete(frame.requestId);
    clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.data);
    else p.reject(new UserError(frame.error ?? DEFAULT_ERROR));
  }
}
