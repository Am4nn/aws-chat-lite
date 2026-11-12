import { useSyncExternalStore } from "react";

/** Tailwind's `md` breakpoint, written as its `max-md` asks it, so a fractional (zoomed) width gets one answer. */
export const PHONE_QUERY = "(width < 48rem)";
/**
 * Below this the sidebar (272 px), the room panel (320 px) and a readable chat (560 px) no longer fit side by side, so
 * the panel slides over the chat instead of squeezing it.
 */
export const NARROW_QUERY = "(width < 1152px)";

function useMatches(query: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", fn);
      return () => list.removeEventListener("change", fn);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * False on the server and during hydration. Layout never depends on these (CSS breakpoints do that, so the first paint
 * is right on any screen); they decide behaviour only, such as which panels are inert.
 */
export const useIsPhone = () => useMatches(PHONE_QUERY);
export const useIsNarrow = () => useMatches(NARROW_QUERY);
