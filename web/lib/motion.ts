import type { Transition } from "motion/react";

/** Durations in seconds. Every UI motion stays between 150 and 500 ms. */
export const dur = { fast: 0.15, base: 0.3, slow: 0.45 } as const;

/** A decelerating curve: quick to respond, gentle to settle. */
export const easeOut = [0.2, 0.9, 0.2, 1] as const;

export const spring = {
  /** Selection highlights gliding between rows: snappy with a slight overshoot. */
  glide: { type: "spring", stiffness: 520, damping: 38, mass: 0.9 } satisfies Transition,
  /** Panels and drawers resizing: no overshoot, so content never bounces past its edge. */
  panel: { type: "spring", stiffness: 380, damping: 40 } satisfies Transition,
  /** Small confirmations (a check mark, a new badge) that should feel like a pop. */
  pop: { type: "spring", stiffness: 600, damping: 22 } satisfies Transition,
};

/**
 * Content entering after a navigation, from the direction the user moved. With reduced motion it only fades: starting
 * at the final position avoids even one frame of offset before Motion skips the slide.
 */
export const enterFrom = (direction: "up" | "down", reduced: boolean) => ({
  initial: { opacity: 0, y: reduced ? 0 : direction === "down" ? 18 : -18 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: dur.slow, ease: easeOut },
});
