import { ValidationError } from "../lib/errors.js";

export const BAD_PATH = 'Use a relative path of up to 200 characters, with no .., backslashes or : * ? " < > |.';

const MAX_LENGTH = 200;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT = 100;
// Characters Windows and S3 tooling choke on; control characters and line breaks; lone surrogates, which are what a
// name that isn't UTF-8 decodes to; and invisible format characters, such as a right-to-left override, that would
// let one name pass for another.
const FORBIDDEN = /[\\:*?"<>|\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Validates a room file path: relative, POSIX, case-sensitive. */
export function workspacePath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > MAX_LENGTH || FORBIDDEN.test(raw)) throw new ValidationError(BAD_PATH);
  const segments = raw.split("/");
  const ok =
    segments.length <= MAX_SEGMENTS &&
    segments.every((s) => s.length >= 1 && s.length <= MAX_SEGMENT && s !== "." && s !== ".." && s === s.trim());
  if (!ok) throw new ValidationError(BAD_PATH);
  return raw;
}

/** The existing path that a file and a folder would share with `path`, if any. */
export function pathClash(existing: string[], path: string): string | null {
  return existing.find((other) => path.startsWith(`${other}/`) || other.startsWith(`${path}/`)) ?? null;
}
