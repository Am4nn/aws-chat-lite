import type { LiveText } from "@/lib/client/voice/transcript";

export const MAX_DICTATION_MS = 60_000;
export const TICK_MS = 250;

export type DictationEngine = "browser" | "transcribe";

type DictationView = { state: "idle" | "starting" | "recording" | "finishing" | "error"; elapsedMs: number; live: LiveText; error?: string };
export const IDLE: DictationView = { state: "idle", elapsedMs: 0, live: { final: "", partial: "" } };

/** What the composer needs from either engine. `available`: false where this browser can't dictate, which hides the mic. */
export type Dictation = DictationView & {
  engine: DictationEngine; available: boolean; start: () => Promise<void> | void; stop: () => void; cancel: () => void;
};

/**
 * Everything a user can read when dictation fails. The cause can carry account details (an access denial names the
 * role's ARN), so it goes to the console and the user gets one of these.
 */
export const DICTATION_ERROR = {
  blocked: "Allow the microphone to dictate.",
  silent: "Didn't catch anything. Try again.",
  stopped: "Dictation stopped. Try again.",
  unavailable: "Dictation isn't available right now.",
  noAudio: "This browser can't record audio here.",
} as const;
