import type { Message } from "@/lib/types";

type ThreadRun = { runId: string; prompt: string };

/**
 * A thread's runs, oldest first, each named by the message that started it. Every answer records its run and that
 * message, so the history is enough. The latest run joins the end while it has no answer yet, named by the newest
 * message since the last answer.
 */
export function threadRuns(messages: Message[], latestRunId: string | undefined): ThreadRun[] {
  const textAt = new Map(messages.map((m) => [m.seq, m.text]));
  const runs = messages.flatMap((m) => (m.agent ? [{ runId: m.agent.runId, prompt: textAt.get(m.agent.firstSeq) ?? "" }] : []));
  if (latestRunId && !runs.some((r) => r.runId === latestRunId)) {
    const asked = messages.slice(messages.findLastIndex((m) => m.agent) + 1).at(-1);
    runs.push({ runId: latestRunId, prompt: asked?.text ?? "" });
  }
  return runs;
}
