"use client";

import { createContext } from "react";

/** A step picked on a run's Map. The Map is the page and its details are in the room panel, so the shell holds it. */
export type PickedStep = { runId: string; nodeId: string; live: boolean };

export const StepPick = createContext<{ picked: PickedStep | null; pick: (step: PickedStep) => void }>({ picked: null, pick: () => {} });
