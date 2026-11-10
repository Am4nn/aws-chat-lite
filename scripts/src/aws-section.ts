const START = "<!-- aws:start -->";
const END = "<!-- aws:end -->";

/** Replace (or append) the real-AWS section of floci-compat.md, so re-running spike:aws stays idempotent. */
export function replaceAwsSection(doc: string, section: string): string {
  const block = `${START}\n${section}\n${END}`;
  const i = doc.indexOf(START);
  const j = doc.indexOf(END);
  if (i >= 0 && j > i) return doc.slice(0, i) + block + doc.slice(j + END.length);
  return `${doc.trimEnd()}\n\n${block}\n`;
}
