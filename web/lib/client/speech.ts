import { bff } from "./bff";

/** One audio element for the whole page, so starting one answer always stops the one before it. */
let audio: HTMLAudioElement | undefined;
let playing: string | null = null;
/** A millisecond of silence as a WAV. */
const SILENCE = "data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==";
const listeners = new Set<() => void>();

function setPlaying(key: string | null) {
  playing = key;
  listeners.forEach((fn) => fn());
}

export const playingKey = () => playing;

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function element() {
  if (!audio) {
    audio = new Audio();
    audio.onended = () => setPlaying(null);
  }
  return audio;
}

/**
 * Safari and iPhone start sound only inside a click, and the click's permission doesn't outlast the seconds speech can
 * take to make. Once an element has played inside a click, it may play again later, so a click plays silence on the
 * shared element before it waits.
 */
export function prime() {
  const el = element();
  el.src = SILENCE;
  el.play().catch(() => {});
}

export async function play(key: string, url: string) {
  const el = element();
  el.pause();
  el.src = url;
  setPlaying(key);
  try {
    await el.play();
  } catch (e) {
    // A play cut short because another one started isn't a failure; the newer one owns the element now.
    if (playing !== key) return;
    setPlaying(null);
    throw e;
  }
}

export function stop() {
  audio?.pause();
  setPlaying(null);
}

export const fetchSpeech = (roomId: string, chatId: string, seq: number) =>
  bff<{ url: string; cached: boolean }>(`/bff/api/rooms/${roomId}/speech`, { body: { chatId, seq } });
