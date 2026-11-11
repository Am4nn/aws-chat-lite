type Box = { key: string; top: number; bottom: number };

/**
 * The row to hold still while content changes elsewhere: the first one still showing at the top of the viewport, and
 * how far its top sits from the viewport's top. Restoring that offset after a change keeps what you're reading put.
 * Rows come lazily and the search stops at the first match, because measuring a row forces layout and this runs on
 * every scroll of a long chat.
 */
export function pickAnchor(rows: Iterable<Box>, viewTop: number): { key: string; top: number } | undefined {
  for (const row of rows) if (row.bottom > viewTop) return { key: row.key, top: row.top - viewTop };
}
