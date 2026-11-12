"use client";

import { createContext, type ReactNode } from "react";
import type { DictationEngine } from "./dictation";

export const DictationEngineContext = createContext<DictationEngine>("transcribe");

/** The stage's choice of engine, read on the server and handed to every composer below it. */
export function DictationEngineProvider({ engine, children }: { engine: DictationEngine; children: ReactNode }) {
  return <DictationEngineContext value={engine}>{children}</DictationEngineContext>;
}
