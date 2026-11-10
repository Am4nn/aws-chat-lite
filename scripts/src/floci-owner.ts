import { assertFlociUp } from "./env.js";
import { assertPortFree, dockerPs, portOwner } from "./ports.js";

/**
 * Before any local deploy: port 4566 must belong to chat-lite's own Floci container (floci-chat), never to another
 * project's Floci, whose persistent volume and CDKToolkit stack must not be touched. Then Floci must answer.
 */
export async function assertOurFlociUp(ps: string = dockerPs(), fetchFn: typeof fetch = fetch): Promise<void> {
  assertPortFree(4566, "floci-chat", ps);
  if (portOwner(ps, 4566) !== "floci-chat") throw new Error("chat-lite's Floci (floci-chat) is not running — run `npm run floci:up`");
  await assertFlociUp(fetchFn);
}
