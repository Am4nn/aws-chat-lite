export const LANGUAGES = ["shell", "python", "javascript"] as const;
export type Language = (typeof LANGUAGES)[number];
export const MAX_TIMEOUT_SEC = 300;
export type ExecResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
/** The path is relative to the working directory. */
export type WorkspaceFile = { path: string; bytes: Uint8Array };
export type ListedFile = { path: string; size: number; sha256: string };

/** Any call on a session that no longer exists. */
export class SandboxGone extends Error {}

export interface Sandbox {
  /**
   * Returns an opaque handle that is valid from any invocation, and whether the session really has internet: a
   * machine may run every session offline. The session ends by itself after `lifetimeSec`.
   */
  start(o: { runId: string; internet: boolean; lifetimeSec: number }): Promise<{ handle: string; internet: boolean }>;
  exec(handle: string, o: { language: Language; code: string; timeoutSec: number }): Promise<ExecResult>;
  /** Creates parent folders. */
  writeFiles(handle: string, files: WorkspaceFile[]): Promise<void>;
  readFiles(handle: string, paths: string[]): Promise<WorkspaceFile[]>;
  /** A session that is already gone is not an error. */
  stop(handle: string): Promise<void>;
}

/**
 * Exit 124 is `timeout` giving up. A SIGKILL (137) after the time limit is `timeout -k` too; before it, most likely
 * the memory limit, which the stderr then says.
 */
export function execOutcome(exitCode: number, stderr: string, elapsedMs: number, timeoutSec: number) {
  const timedOut = exitCode === 124 || (exitCode === 137 && elapsedMs >= timeoutSec * 1000);
  return { timedOut, stderr: exitCode === 137 && !timedOut ? `${stderr}\nkilled (likely out of memory)` : stderr };
}
