import { fakeModel } from "./fake.js";
import type { ModelGateway } from "./gateway.js";

export function gateway(env: Record<string, string | undefined> = process.env): ModelGateway {
  if (env.MODEL_GATEWAY === "fake") return fakeModel();
  throw new Error(`Unknown model gateway: ${env.MODEL_GATEWAY}`);
}
