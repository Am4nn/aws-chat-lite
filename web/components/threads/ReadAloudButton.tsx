"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Square, Volume2 } from "lucide-react";
import { errorText } from "@/lib/client/bff";
import { fetchSpeech, play, playingKey, stop, subscribe } from "@/lib/client/speech";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/overlays/Toast";

/** Reads one agent answer aloud. Only one answer plays at a time, so starting another turns this one back to idle. */
export function ReadAloudButton({ roomId, chatId, seq }: { roomId: string; chatId: string; seq: number }) {
  const toast = useToast();
  const key = `${chatId}/${seq}`;
  const playing = useSyncExternalStore(subscribe, playingKey, () => null) === key;
  const [loading, setLoading] = useState(false);
  // Leaving the thread takes its controls away, so the answer stops with them rather than playing on out of reach.
  useEffect(() => () => {
    if (playingKey() === key) stop();
  }, [key]);

  async function toggle() {
    if (playing) return stop();
    setLoading(true);
    try {
      const { url } = await fetchSpeech(roomId, chatId, seq);
      await play(key, url);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading}
      aria-label={playing ? "Stop reading" : "Read aloud"}
      aria-pressed={playing}
      title={playing ? "Stop reading" : "Read aloud"}
      className="-my-1 ml-1 inline-grid size-6 place-items-center rounded-md align-middle text-text-3 transition-[background-color,color,transform] hover:bg-surface-2 hover:text-text active:scale-[0.92] disabled:cursor-default disabled:hover:bg-transparent"
    >
      {loading ? <Spinner /> : playing ? <Square aria-hidden="true" size={12} fill="currentColor" /> : <Volume2 aria-hidden="true" size={14} />}
    </button>
  );
}
