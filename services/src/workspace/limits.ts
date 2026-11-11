export const ROOM_FILES_BYTES = 104_857_600;
export const MAX_ROOM_FILE_BYTES = 26_214_400;
export const MAX_ROOM_FILES = 1000;
/** Folders the sandbox may create but that are never synced to the room. */
export const SKIPPED_DIRS = [".git", "node_modules", ".venv", "venv", "__pycache__", ".cache"];

export const SANDBOX_MICROS_PER_SEC = 61;

/** Wall time is charged in whole seconds, at least one. */
export const sandboxCostMicros = (ms: number): number => Math.max(1, Math.ceil(ms / 1000)) * SANDBOX_MICROS_PER_SEC;
