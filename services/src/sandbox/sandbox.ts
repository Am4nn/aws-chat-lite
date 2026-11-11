export type Language = "shell" | "python" | "javascript";
export type ExecResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };
/** The path is relative to the working directory. */
export type WorkspaceFile = { path: string; bytes: Uint8Array };
export type ListedFile = { path: string; size: number; sha256: string };

/** Any call on a session that no longer exists. */
export class SandboxGone extends Error {}

export interface Sandbox {
  /** Returns an opaque handle that is valid from any invocation. */
  start(o: { runId: string; internet: boolean }): Promise<string>;
  exec(handle: string, o: { language: Language; code: string; timeoutSec: number }): Promise<ExecResult>;
  /** Creates parent folders. */
  writeFiles(handle: string, files: WorkspaceFile[]): Promise<void>;
  readFiles(handle: string, paths: string[]): Promise<WorkspaceFile[]>;
  removeFiles(handle: string, paths: string[]): Promise<void>;
  /** A session that is already gone is not an error. */
  stop(handle: string): Promise<void>;
}
