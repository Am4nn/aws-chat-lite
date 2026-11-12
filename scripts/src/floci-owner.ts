import { assertFlociUp } from "./env.js";
import { FLOCI_PORT, assertPortFree, dockerPs, portOwner } from "./ports.js";

/**
 * Before any local command: Floci's port must belong to chat-lite's own Floci container (floci-chat), never to another
 * project's Floci, whose persistent volume and CDKToolkit stack must not be touched. Then Floci must answer.
 */
export async function assertOurFlociUp(ps: string = dockerPs(), fetchFn: typeof fetch = fetch): Promise<void> {
  assertPortFree(FLOCI_PORT, "floci-chat", ps);
  if (portOwner(ps, FLOCI_PORT) !== "floci-chat") throw new Error("chat-lite's Floci (floci-chat) is not running — run `npm run floci:up`");
  await assertFlociUp(fetchFn);
}
