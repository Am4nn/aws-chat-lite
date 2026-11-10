import { withDurableExecution, type DurableContext } from "@aws/durable-execution-sdk-js";

/** Two checkpointed steps around a 5 s durable wait (the function is not running while it waits). */
const run = async (_event: unknown, context: DurableContext) => {
  const started = await context.step("start", async () => Date.now());
  const a = await context.step("a", async () => 1);
  await context.wait({ seconds: 5 });
  const b = await context.step("b", async () => 2);
  const waitedMs = await context.step("elapsed", async () => Date.now() - started);
  return { a, b, waitedMs };
};

export const handler = withDurableExecution(run);
