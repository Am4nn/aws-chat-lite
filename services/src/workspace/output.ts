import type { ExecResult } from "../sandbox/sandbox.js";
import type { FilesSynced } from "./types.js";

const KEEP_CHARS = 8000;
const SHOWN_PATHS = 50;
const SHOWN_NOTES = 20;

function tail(text: string): string {
  const cut = text.length - KEEP_CHARS;
  return cut > 0 ? `… (${cut} earlier characters cut)\n${text.slice(cut)}` : text;
}

/** The exit code, time and the tail of each stream: what a `sandbox_run` call reports before its file changes. */
export function execText(r: ExecResult, ms: number): string {
  const lines = [`exit ${r.exitCode} · ${ms} ms${r.timedOut ? " · timed out" : ""}`];
  if (r.stdout) lines.push("--- stdout", tail(r.stdout).trimEnd());
  if (r.stderr) lines.push("--- stderr", tail(r.stderr).trimEnd());
  return lines.join("\n");
}

const capped = (list: string[], max: number, more: string) =>
  list.length > max ? [...list.slice(0, max), `…and ${list.length - max} more${more}`] : list;

/**
 * A step that unpacks thousands of files would otherwise put every path and note into the model's context on each
 * later turn, and past DynamoDB's 400 KB item limit in the event log.
 */
export const capSynced = (s: FilesSynced): FilesSynced => ({
  written: capped(s.written, SHOWN_PATHS, ""), deleted: capped(s.deleted, SHOWN_PATHS, ""), notes: capped(s.notes, SHOWN_NOTES, " notes."),
});

/** The text a `sandbox_run` call returns to the model. */
export function toolOutput(head: string, s: FilesSynced): string {
  const lines = [head];
  if (s.written.length) lines.push(`Saved to room files: ${s.written.join(", ")}`);
  if (s.deleted.length) lines.push(`Deleted from room files: ${s.deleted.join(", ")}`);
  return [...lines, ...s.notes].join("\n");
}
