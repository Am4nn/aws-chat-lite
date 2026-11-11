import { bff } from "./bff";

/** One audio element for the whole page, so starting one answer always stops the one before it. */
let audio: HTMLAudioElement | undefined;
let playing: string | null = null;
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

export async function play(key: string, url: string) {
  if (!audio) {
    audio = new Audio();
    audio.onended = () => setPlaying(null);
  }
  audio.pause();
  audio.src = url;
  setPlaying(key);
  try {
    await audio.play();
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
