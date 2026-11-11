import { useEffect, useRef } from "react";

/**
 * While `active`, Escape calls `onEscape` and is marked handled, so the room shell's own Escape (which closes the phone
 * drawer or panel) leaves it alone. The capture phase runs this before every bubbling listener, whichever was added
 * first, and only the first open layer to see the key handles it.
 */
export function useEscape(active: boolean, onEscape: () => void) {
  const latest = useRef(onEscape);
  useEffect(() => { latest.current = onEscape; });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);
}
