"use client";

import { useLayoutEffect, useRef } from "react";
import { animate, useMotionValue } from "motion/react";
import { enterFrom } from "@/lib/motion";

/**
 * The content's slide-in, run each time the place shown changes (a tap's target the moment it is tapped, or a route
 * the router committed by itself), but not for the page the room opened on. It lives in motion values rather than on
 * one element, so the skeleton that slides in on the tap and the page that replaces it mid-slide share one movement
 * instead of the page snapping into place or sliding a second time.
 */
export function useEntrance(place: string, direction: "up" | "down", reduced: boolean) {
  const y = useMotionValue(0);
  const opacity = useMotionValue(1);
  const shown = useRef(place);

  // Before paint, so the first frame of the new place is already at its starting offset. Starting an animation on a
  // motion value stops the one before, and nothing stops it otherwise: the direction is recomputed on the render after
  // a move, and that must not cut the slide short.
  useLayoutEffect(() => {
    if (shown.current === place) return;
    shown.current = place;
    const { initial, transition } = enterFrom(direction, reduced);
    y.set(initial.y);
    opacity.set(initial.opacity);
    animate(y, 0, transition);
    animate(opacity, 1, transition);
  }, [place, direction, reduced, y, opacity]);

  return { y, opacity };
}
