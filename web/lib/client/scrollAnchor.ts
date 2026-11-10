type Box = { key: string; top: number; bottom: number };

/**
 * The row to hold still while content changes elsewhere: the first one still showing at the top of the viewport, and
 * how far its top sits from the viewport's top. Restoring that offset after a change keeps what you're reading put.
 */
export function pickAnchor(rows: Box[], viewTop: number): { key: string; top: number } | undefined {
  const row = rows.find((r) => r.bottom > viewTop);
  return row && { key: row.key, top: row.top - viewTop };
}
