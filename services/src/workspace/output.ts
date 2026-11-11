import type { ExecResult } from "../sandbox/sandbox.js";
import type { FilesSynced } from "./types.js";

const KEEP_CHARS = 8000;

function tail(text: string): string {
  const cut = text.length - KEEP_CHARS;
  return cut > 0 ? `… (${cut} earlier characters cut)\n${text.slice(cut)}` : text;
}

/** The text a `sandbox_run` call returns to the model. */
export function toolOutput(r: ExecResult, ms: number, s: FilesSynced): string {
  const lines = [`exit ${r.exitCode} · ${ms} ms${r.timedOut ? " · timed out" : ""}`];
  if (r.stdout) lines.push("--- stdout", tail(r.stdout).trimEnd());
  if (r.stderr) lines.push("--- stderr", tail(r.stderr).trimEnd());
  if (s.written.length) lines.push(`Saved to room files: ${s.written.join(", ")}`);
  if (s.deleted.length) lines.push(`Deleted from room files: ${s.deleted.join(", ")}`);
  return [...lines, ...s.notes].join("\n");
}
