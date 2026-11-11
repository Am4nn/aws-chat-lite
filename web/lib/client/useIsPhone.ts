import { useSyncExternalStore } from "react";

/** Tailwind's `md` breakpoint: below it the sidebar and the panel become overlays. */
export const PHONE_QUERY = "(max-width: 767px)";

const subscribe = (fn: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", fn);
  return () => query.removeEventListener("change", fn);
};

/**
 * False on the server and during hydration. Layout never depends on it (CSS breakpoints do that, so the first paint
 * is right on any screen); it decides behaviour only, such as which panels are inert.
 */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}
