import type { PushJob, PushNote } from "./types.js";

const EXCERPT = 140;

/** One line of at most 140 code points, so an emoji is never cut in half. */
function excerpt(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length <= EXCERPT ? chars.join("") : `${chars.slice(0, EXCERPT - 1).join("")}…`;
}

function runTitle(job: Extract<PushJob, { kind: "run" }>, thread: string): string {
  switch (job.status) {
    case "done": return `#${thread} finished`;
    case "failed": return `#${thread} failed`;
    case "capped": return `#${thread} stopped: the room's budget is used up`;
    case "stopped": return job.stoppedBy ? `#${thread} was stopped by ${job.stoppedBy}` : `#${thread} stopped`;
  }
}

/**
 * The notification for a job. `at` names the room and the chat or thread; `thread` is set when a mention is in a
 * thread, which links it to the thread page instead of a chat.
 */
export function noteFor(job: PushJob, at: { room: string; name: string; thread?: number }): PushNote {
  const body = (text: string) => `${at.room}: ${text}`;
  const threadUrl = (n: number) => `/r/${job.roomId}/t/${n}`;
  switch (job.kind) {
    case "mention": {
      const where = at.thread === undefined
        ? { url: `/r/${job.roomId}/c/${job.chatId}`, tag: `chat-${job.chatId}` }
        : { url: threadUrl(at.thread), tag: `thread-${job.chatId}` };
      const whom = job.everyone ? "everyone" : "you";
      return { title: `${job.authorName} mentioned ${whom} in #${at.name}`, body: body(excerpt(job.text)), ...where, urgency: "normal" };
    }
    case "run": {
      const text = job.status === "done" ? job.summary || "The agent answered." : job.reason ?? "";
      return { title: runTitle(job, at.name), body: body(text), url: threadUrl(job.number), tag: `thread-${job.threadId}`, urgency: "normal" };
    }
    case "approval":
      return {
        title: `#${at.name} needs approval`, body: body(job.title), url: threadUrl(job.number),
        tag: `approval-${job.runId}-${job.step}`, urgency: "high",
      };
  }
}
