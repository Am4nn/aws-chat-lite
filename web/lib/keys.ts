type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; target: unknown };
type ElementLike = { tagName?: string; closest?: (selector: string) => unknown } | null;

/**
 * Ctrl K (Cmd K on a Mac) toggles the command palette. While someone is typing in another field the shortcut is left
 * alone, so it never steals a keystroke from them; inside the palette's own input it still closes the palette.
 */
export function isPaletteShortcut(e: KeyLike): boolean {
  if (e.key.toLowerCase() !== "k" || !(e.ctrlKey || e.metaKey)) return false;
  const el = e.target as ElementLike;
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "");
  return !typing || !!el?.closest?.("[cmdk-root]");
}
