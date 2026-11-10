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

/** The local spike rewrites the whole report: carry the committed real-AWS block over instead of erasing it. */
export function keepAwsSection(oldDoc: string, newDoc: string): string {
  const i = oldDoc.indexOf(START);
  const j = oldDoc.indexOf(END);
  if (i < 0 || j < i) return newDoc;
  return replaceAwsSection(newDoc, oldDoc.slice(i + START.length, j).replace(/^\n|\n$/g, ""));
}

/**
 * End of spike:aws. Destroy runs first and on its own (a report that can't be written must never leave
 * cl-aws-spike running in Sydney); any failure makes the exit code non-zero.
 */
export function finishAwsSpike(steps: { destroy: () => void; writeReport: () => void; log: (line: string) => void }): number {
  let code = 0;
  try {
    steps.destroy();
  } catch (e) {
    code = 1;
    steps.log(`❌ destroy failed (${(e as Error).message}). Run it yourself: cd infra && npx cdk destroy cl-aws-spike -c stage=aws -c spike=true --profile ig`);
  }
  try {
    steps.writeReport();
  } catch (e) {
    code = 1;
    steps.log(`❌ could not write the report: ${(e as Error).message}`);
  }
  return code;
}
