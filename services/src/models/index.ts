import { modelInfo, priceMicros, type Provider } from "./catalog.js";
import { fakeModel } from "./fake.js";
import type { ModelChunk, ModelGateway, ModelProvider } from "./gateway.js";

type LiveProviders = Record<Exclude<Provider, "fake">, ModelProvider>;

/**
 * The one door to every model. `fake` serves every model id from the fake, billed at that id's rates, so local runs
 * cost what real ones would; `live` sends each model to its own provider. Either way the cost of a call is computed
 * here from the tokens the provider reports, never by the provider.
 */
export function gateway(env: Record<string, string | undefined> = process.env, providers?: LiveProviders): ModelGateway {
  const mode = env.MODEL_GATEWAY;
  if (mode !== "fake" && mode !== "live") throw new Error(`Unknown model gateway: ${mode}`);
  const fake = fakeModel();
  const servedBy = (model: string): Provider => (mode === "fake" ? "fake" : modelInfo(model).provider);
  const providerOf = (model: string): ModelProvider => {
    const provider = servedBy(model);
    if (provider === "fake") return fake;
    if (!providers) throw new Error("Live models aren't wired here.");
    return providers[provider];
  };

  return {
    servedBy,
    async *stream(req): AsyncGenerator<ModelChunk> {
      for await (const chunk of providerOf(req.model).stream(req)) {
        yield chunk.type === "usage" ? { ...chunk, costMicros: priceMicros(req.model, chunk) } : chunk;
      }
    },
  };
}
