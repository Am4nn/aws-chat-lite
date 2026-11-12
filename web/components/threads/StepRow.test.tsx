import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunItem } from "@/lib/client/run";
import { StepRow } from "./StepRow";

type Step = Extract<RunItem, { kind: "step" }>;
const tool: Step = { kind: "step", step: 1, name: "web_search", detail: "floci durable", status: "done", ms: 400, startedAt: "2026-11-12T04:53:00Z" };
const handOff: Step = {
  ...tool, name: "delegate", detail: "researcher: Look up",
  helper: { lane: 1, agentName: "researcher", task: "Look up what the room knows", status: "done", items: [], text: "Found 3 notes." },
};
const TICK = "m5 12 4.5 4.5L19 7";
const html = (step: Step, nested = false) => renderToStaticMarkup(<StepRow roomId="r" step={step} enter={false} nested={nested} />);

describe("StepRow", () => {
  it("shows a tool call by its name and detail, with a tick", () => {
    const out = html(tool);
    expect(out).toContain("web_search");
    expect(out).toContain("floci durable");
    expect(out).toContain(TICK);
  });

  it("shows a hand-off as the helper asked, with an agent's tile instead of a tick, and the task", () => {
    const out = html(handOff);
    expect(out).toContain("Asked @researcher");
    expect(out).toContain("“Look up what the room knows”");
    expect(out).toContain("lucide-bot");
    expect(out).not.toContain("rounded-full");
    expect(out).not.toContain(TICK);
  });

  it("draws a helper's own steps smaller and dimmer than the hand-off they belong to", () => {
    const out = html(tool, true);
    expect(out).toContain('width="12"');
    expect(out).toContain("text-lime/60");
  });
});
