"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { bff, errorText } from "@/lib/client/bff";
import { audioFrame, endFrame, readFrame } from "@/lib/client/voice/eventstream";
import { chunker, downsample } from "@/lib/client/voice/pcm";
import { applyResults, transcriptText, type LiveText } from "@/lib/client/voice/transcript";

export const MAX_DICTATION_MS = 60_000;
const FINAL_WAIT_MS = 3000;
const TICK_MS = 250;
const SAMPLE_RATE = 16000;
const BLOCKED = "Microphone access is blocked. Allow it in the site settings to dictate.";

type View = { state: "idle" | "starting" | "recording" | "finishing" | "error"; elapsedMs: number; live: LiveText; error?: string };
const IDLE: View = { state: "idle", elapsedMs: 0, live: { final: "", partial: "" } };

/** One dictation, from the click to the last word. `over` is set as soon as it starts ending, so it ends only once. */
type Attempt = {
  roomId: string; ctx: AudioContext; stream?: MediaStream; ws?: WebSocket; sessionId?: string; reported?: boolean;
  openedAt?: number; endedAt?: number; timer?: ReturnType<typeof setInterval>; live: LiveText; over: boolean;
};

/**
 * Dictation for the composer. The mic streams straight to Transcribe over a presigned WebSocket, the words show while
 * you speak, and the transcript goes to `onText` when you stop. Minting the URL reserved a minute of transcription on
 * the room's budget, so every way out reports the seconds used, which refunds the rest.
 */
export function useDictation({ roomId, onText }: { roomId: string; onText: (text: string) => void }) {
  const [view, setView] = useState(IDLE);
  const current = useRef<Attempt | null>(null);
  const latestOnText = useRef(onText);
  useEffect(() => { latestOnText.current = onText; });

  // Safe to call again: a cancel can land while `start` is still waiting for the mic, the session or the socket.
  function release(a: Attempt) {
    clearInterval(a.timer);
    a.ws?.close();
    a.stream?.getTracks().forEach((t) => t.stop());
    if (a.ctx.state !== "closed") void a.ctx.close();
    if (a.sessionId && !a.reported) {
      a.reported = true;
      const seconds = a.openedAt ? Math.ceil(((a.endedAt ?? Date.now()) - a.openedAt) / 1000) : 0;
      // A lost report leaves the whole minute billed, which errs on the side of the room's cap.
      bff(`/bff/api/rooms/${a.roomId}/voice/sessions/${a.sessionId}/done`, { body: { seconds } }).catch(() => {});
    }
  }

  async function end(a: Attempt, keepWords: boolean, error?: string) {
    if (a.over) return;
    a.over = true;
    a.endedAt = Date.now();
    clearInterval(a.timer);
    if (keepWords && !error && a.ws?.readyState === WebSocket.OPEN) {
      setView((v) => ({ ...v, state: "finishing" }));
      a.ws.send(endFrame());
      await closed(a.ws);
    }
    release(a);
    if (current.current === a) current.current = null;
    const text = transcriptText(a.live);
    if (keepWords && text) latestOnText.current(text);
    setView(error ? { ...IDLE, state: "error", error } : IDLE);
  }

  function record(a: Attempt, mic: MediaStream, ws: WebSocket) {
    ws.addEventListener("message", (e: MessageEvent<ArrayBuffer>) => {
      const frame = readFrame(new Uint8Array(e.data));
      if (frame.kind === "error") return void end(a, true, `Dictation stopped: ${frame.message}`);
      a.live = applyResults(a.live, frame.results);
      setView((v) => ({ ...v, live: a.live }));
    });
    ws.addEventListener("close", (e: CloseEvent) => void end(a, true, `Dictation stopped: ${e.reason || "the connection closed."}`));

    const send = chunker(3200, (bytes) => ws.send(audioFrame(bytes)));
    const ratio = a.ctx.sampleRate / SAMPLE_RATE;
    let carry = new Float32Array(0);
    const tap = new AudioWorkletNode(a.ctx, "pcm-tap");
    tap.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (a.over) return;
      const input = new Float32Array(carry.length + data.length);
      input.set(carry);
      input.set(data, carry.length);
      const pcm = downsample(input, a.ctx.sampleRate, SAMPLE_RATE);
      carry = input.slice(Math.floor(pcm.length * ratio));
      send(pcm);
    };
    a.ctx.createMediaStreamSource(mic).connect(tap);
    // Wired to the speakers so the browser keeps running it; the tap writes no output, so nothing is heard.
    tap.connect(a.ctx.destination);

    a.openedAt = Date.now();
    a.timer = setInterval(() => {
      const elapsedMs = Date.now() - a.openedAt!;
      if (elapsedMs >= MAX_DICTATION_MS) void end(a, true);
      else setView((v) => ({ ...v, elapsedMs }));
    }, TICK_MS);
    setView((v) => ({ ...v, state: "recording" }));
  }

  async function start() {
    if (current.current) return;
    if (typeof AudioWorkletNode === "undefined" || !navigator.mediaDevices) {
      return setView({ ...IDLE, state: "error", error: "This browser can't record audio here." });
    }
    // Safari lets audio start only inside the click that asked for it, so the context is made before any await.
    const a: Attempt = { roomId, ctx: new AudioContext(), live: IDLE.live, over: false };
    current.current = a;
    setView({ ...IDLE, state: "starting" });
    try {
      // The mic comes first, so a refused permission never reserves a minute on the budget.
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      a.stream = mic;
      if (a.over) return release(a);
      const session = await bff<{ sessionId: string; url: string }>(`/bff/api/rooms/${roomId}/voice/sessions`, { body: {} });
      a.sessionId = session.sessionId;
      if (a.over) return release(a);
      await a.ctx.audioWorklet.addModule("/pcm-worklet.js");
      a.ws = await openSocket(session.url);
      if (a.over) return release(a);
      record(a, mic, a.ws);
    } catch (e) {
      await end(a, false, e instanceof DOMException && e.name === "NotAllowedError" ? BLOCKED : errorText(e));
    }
  }

  const stop = () => { if (current.current) void end(current.current, true); };
  const cancel = () => (current.current ? void end(current.current, false) : setView(IDLE));

  // Leaving the page mid-dictation still turns the mic off and reports the time.
  const endOnLeave = useEffectEvent(() => { if (current.current) void end(current.current, false); });
  useEffect(() => () => endOnLeave(), []);

  return { ...view, start, stop, cancel };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("close", () => reject(new Error("Dictation stopped: the transcriber couldn't be reached.")));
  });
}

/** Transcribe sends its last results and closes after the end frame; a socket that stays open isn't waited on long. */
const closed = (ws: WebSocket) => new Promise<void>((resolve) => {
  ws.addEventListener("close", () => resolve());
  setTimeout(resolve, FINAL_WAIT_MS);
});
