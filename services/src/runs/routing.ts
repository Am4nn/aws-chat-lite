import { JOBS, NAMING_MODEL, ROUTER_MODEL, type ModelPick } from "../models/catalog.js";
import { NAME_PROMPT } from "../models/gateway.js";
import { modelIdOf, parseRoute, ROUTER_PROMPT, routerInput } from "../models/picks.js";
import { threadsRepo } from "../threads/repo.js";
import { buildContext, threadMessages } from "./context.js";
import { notifyRun } from "./notify.js";
import { runsRepo, type Run } from "./repo.js";
import { budgetLeft, callModel, recordCall, type Writer } from "./steps.js";

type Choice = { model: string; by: "pick" | "default" | "auto"; costMicros: number };
/** What to choose for: the pick, the step whose result the router's call settles, and the message Auto routes on. */
type Ask = { pick: ModelPick; by: "pick" | "default"; step: string; message: () => Promise<{ author: string; text: string }> };

/**
 * A pick names its model. Auto asks the router on Haiku to choose Haiku or Sonnet from the message, and takes Sonnet
 * without asking once the budget is spent, or when the router fails or declines. A retried step keeps the router's
 * recorded choice instead of asking again.
 */
export async function chooseModel(run: Run, writer: Writer, ask: Ask): Promise<Choice> {
  if (ask.pick !== "auto") return { model: modelIdOf(ask.pick), by: ask.by, costMicros: run.costMicros };
  const recorded = await runsRepo().recorded<Choice>(run.runId, ask.step);
  if (recorded) return recorded;
  const sonnet = modelIdOf("sonnet");
  if (!await budgetLeft(run)) return { model: sonnet, by: "auto", costMicros: run.costMicros };
  const { author, text } = await ask.message();
  const call = await callModel({
    model: ROUTER_MODEL, system: ROUTER_PROMPT, tools: [], ...JOBS.route, messages: [{ role: "user", author, text: routerInput(text) }],
  });
  const choice: Choice = {
    model: call.failed || call.end?.stop === "refusal" ? sonnet : parseRoute(call.text), by: "auto",
    costMicros: run.costMicros + (call.usage?.costMicros ?? 0),
  };
  return call.usage ? recordCall(run, writer, { model: ROUTER_MODEL, job: "route", step: ask.step }, call.usage, choice) : choice;
}

/** Settles the model the run answers on, from its first message, before its first model call. Logs `routed` once. */
export async function routeRun(run: Run): Promise<{ model: string; costMicros: number }> {
  const runs = runsRepo();
  const [events, writer] = await Promise.all([runs.allEvents(run.runId), runs.eventWriter(run.runId)]);
  const choice = await chooseModel(run, writer, {
    pick: run.pick, by: run.pickBy, step: "route",
    message: async () => {
      const first = (await runs.prior(run.threadId, run.firstSeq)).at(-1);
      return { author: first?.authorName ?? "", text: first?.text ?? "" };
    },
  });
  const logged = events.find((e) => e.type === "routed");
  const routed = logged ?? await writer.append({ type: "routed", model: choice.model, by: choice.by });
  const thread = await runs.progress(run, { model: choice.model });
  if (!logged && thread) await notifyRun(run.roomId, thread, routed.seq);
  return { model: choice.model, costMicros: choice.costMicros };
}

type Named = { name: string; costMicros: number };

/** Asks the model for a name for the thread from its first message. Returns the run's cost so far. */
export async function nameThread(run: Run): Promise<number> {
  const named = await runsRepo().recorded<Named>(run.runId, "name") ?? await suggestName(run);
  if (named.name) await threadsRepo().nameIfProvisional(run.roomId, run.threadId, named.name);
  return named.costMicros;
}

async function suggestName(run: Run): Promise<Named> {
  if (!await budgetLeft(run)) return { name: "", costMicros: run.costMicros };
  const runs = runsRepo();
  const messages = buildContext(threadMessages(await runs.prior(run.threadId, run.firstSeq)), []);
  const call = await callModel({ model: NAMING_MODEL, system: NAME_PROMPT, messages, tools: [], ...JOBS.name });
  // A name is a nicety: a failed call keeps the numbered name, which anyone can still change, and the run goes on.
  const named = { name: call.failed ? "" : call.text.trim(), costMicros: run.costMicros + (call.usage?.costMicros ?? 0) };
  if (!call.usage) return named;
  return recordCall(run, await runs.eventWriter(run.runId), { model: NAMING_MODEL, job: "name", step: "name" }, call.usage, named);
}
