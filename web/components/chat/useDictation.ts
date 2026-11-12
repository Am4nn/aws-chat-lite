"use client";

import { useContext } from "react";
import type { Dictation } from "./dictation";
import { DictationEngineContext } from "./DictationEngine";
import { useBrowserDictation } from "./useBrowserDictation";
import { useTranscribeDictation } from "./useTranscribeDictation";

/** Dictation for the composer, on the engine the stage chose. */
export function useDictation(args: { roomId: string; onText: (text: string) => void }): Dictation {
  const engine = useContext(DictationEngineContext);
  // Both hooks run on every render so their order never changes; the one not chosen stays idle and holds nothing open.
  const browser = useBrowserDictation(args);
  const transcribe = useTranscribeDictation(args);
  return engine === "browser" ? browser : transcribe;
}
