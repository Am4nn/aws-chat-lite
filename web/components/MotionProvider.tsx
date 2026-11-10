"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** People who ask their OS for reduced motion get instant state changes instead of transform animations. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
