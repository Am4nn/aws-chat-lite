import Anthropic from "@anthropic-ai/sdk";
import { anthropicProvider } from "./anthropic.js";
import { modelInfo, priceMicros, type Provider } from "./catalog.js";
import { fakeModel } from "./fake.js";
import type { ModelChunk, ModelGateway, ModelProvider } from "./gateway.js";
import { modelKeys, type ModelKeys } from "./keys.js";

type LiveProviders = Record<Exclude<Provider, "fake">, ModelProvider>;

const notSetUp = (message: string): ModelProvider => ({
  async *stream() {
    throw new Error(message);
  },
});

/** Claude and DeepSeek both speak the Messages API, so one SDK serves both; a missing key fails only its own models. */
export function liveProviders(keys: ModelKeys): LiveProviders {
  return {
    anthropic: keys.anthropicKey
      ? anthropicProvider(new Anthropic({ apiKey: keys.anthropicKey }), "anthropic")
      : notSetUp("Claude isn't set up here (no ANTHROPIC_API_KEY)."),
    deepseek: keys.deepseekKey
      ? anthropicProvider(
          new Anthropic({ apiKey: keys.deepseekKey, baseURL: keys.deepseekBaseUrl ?? "https://api.deepseek.com/anthropic" }),
          "deepseek",
        )
      : notSetUp("DeepSeek isn't set up here (no DEEPSEEK_API_KEY)."),
  };
}

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
  // The keys are read on the first real call, so a gateway that only serves the fake never needs them.
  let live: Promise<LiveProviders> | undefined;
  const providerOf = async (model: string): Promise<ModelProvider> => {
    const provider = servedBy(model);
    if (provider === "fake") return fake;
    live ??= providers ? Promise.resolve(providers) : modelKeys(env).then(liveProviders);
    return (await live)[provider];
  };

  return {
    servedBy,
    async *stream(req): AsyncGenerator<ModelChunk> {
      for await (const chunk of (await providerOf(req.model)).stream(req)) {
        yield chunk.type === "usage" ? { ...chunk, costMicros: priceMicros(req.model, chunk) } : chunk;
      }
    },
  };
}
