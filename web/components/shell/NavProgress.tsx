"use client";

import { motion, useReducedMotion } from "motion/react";
import { useNavPending } from "./NavPending";

/**
 * A thin neutral bar along the top while a navigation is in flight. It waits 120 ms, so a quick navigation never
 * flashes it, then creeps to 80 % and holds until the route commits: it says "loading", never how much is left.
 * With reduced motion it appears, still, after the same wait.
 */
export function NavProgress() {
  const pending = useNavPending();
  const reduced = useReducedMotion();
  if (!pending) return null;
  return (
    <motion.div
      // Keyed, so a tap on another place mid-flight starts the creep over.
      key={pending}
      data-nav-progress
      aria-hidden="true"
      initial={{ scaleX: reduced ? 0.8 : 0, opacity: 0 }}
      animate={{ scaleX: 0.8, opacity: 1 }}
      transition={reduced ? { delay: 0.12, duration: 0 } : { delay: 0.12, duration: 8, ease: [0.1, 0.7, 0.3, 1], opacity: { delay: 0.12, duration: 0.15 } }}
      className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-50 h-0.5 origin-left bg-text-3"
    />
  );
}
