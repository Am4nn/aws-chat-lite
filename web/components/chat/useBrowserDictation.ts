"use client";

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { transcriptText, type LiveText } from "@/lib/client/voice/transcript";
import { DICTATION_ERROR, IDLE, MAX_DICTATION_MS, TICK_MS, type Dictation } from "./dictation";

/** The part of the Web Speech API used here. TypeScript's DOM types leave the recognizer out: no standard one ships yet. */
type Recognizer = {
  continuous: boolean; interimResults: boolean; lang: string;
  onstart: (() => void) | null;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};

// Chrome, Edge and Safari ship it prefixed; Firefox has none.
const recognizerClass = () => {
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};
const neverChanges = () => () => {};

const ERRORS: Record<string, string> = {
  "not-allowed": DICTATION_ERROR.blocked,
  "service-not-allowed": DICTATION_ERROR.blocked,
  "no-speech": DICTATION_ERROR.silent,
};

type Attempt = { rec: Recognizer; live: LiveText; error?: string; timer?: ReturnType<typeof setInterval> };

/**
 * Dictation by the browser's own speech recognition (in Chrome, Google's servers hear the audio). It costs the room
 * nothing, so there is no session to mint and no time to report; the minute's cap only keeps the strip the same.
 */
export function useBrowserDictation({ onText }: { onText: (text: string) => void }): Dictation {
  // The server can't know the browser, so it renders no mic and the client adds it once hydrated.
  const available = useSyncExternalStore(neverChanges, () => !!recognizerClass(), () => false);
  const [view, setView] = useState(IDLE);
  const current = useRef<Attempt | null>(null);
  const latestOnText = useRef(onText);
  useEffect(() => { latestOnText.current = onText; });

  function end(a: Attempt, keepWords: boolean) {
    clearInterval(a.timer);
    if (current.current === a) current.current = null;
    const text = transcriptText(a.live);
    if (keepWords && text) latestOnText.current(text);
    setView(a.error ? { ...IDLE, state: "error", error: a.error } : IDLE);
  }

  function start() {
    const Recognizer = recognizerClass();
    if (current.current || !Recognizer) return;
    const rec = new Recognizer();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language;
    const a: Attempt = { rec, live: IDLE.live };
    current.current = a;

    rec.onstart = () => {
      const openedAt = Date.now();
      a.timer = setInterval(() => {
        const elapsedMs = Date.now() - openedAt;
        if (elapsedMs >= MAX_DICTATION_MS) stop();
        else setView((v) => ({ ...v, elapsedMs }));
      }, TICK_MS);
      setView((v) => ({ ...v, state: "recording" }));
    };
    // The list holds every result of the session, settled ones first, so the live text is rebuilt from all of it.
    rec.onresult = ({ results }) => {
      const parts = Array.from(results);
      const words = (final: boolean) => parts.filter((r) => r.isFinal === final).map((r) => r[0].transcript.trim()).join(" ");
      a.live = { final: words(true), partial: words(false) };
      setView((v) => ({ ...v, live: a.live }));
    };
    rec.onerror = ({ error }) => {
      console.error("Speech recognition:", error);
      a.error = ERRORS[error] ?? DICTATION_ERROR.stopped;
    };
    // The browser ends the session after Stop, an error, or a long silence; the words so far are kept each time.
    rec.onend = () => end(a, true);
    setView({ ...IDLE, state: "starting" });
    rec.start();
  }

  function stop() {
    const a = current.current;
    if (!a) return;
    clearInterval(a.timer);
    setView((v) => ({ ...v, state: "finishing" }));
    a.rec.stop();
  }

  function cancel() {
    const a = current.current;
    if (!a) return setView(IDLE);
    a.rec.onend = a.rec.onerror = null;
    a.rec.abort();
    end(a, false);
  }

  const endOnLeave = useEffectEvent(() => { if (current.current) cancel(); });
  useEffect(() => () => endOnLeave(), []);

  return { ...view, engine: "browser", available, start, stop, cancel };
}
