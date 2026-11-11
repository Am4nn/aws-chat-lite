export type ModelPick =
  | "auto"
  | "sonnet"
  | "haiku"
  | "opus"
  | "fable"
  | "deepseek-flash"
  | "deepseek-pro"
  | "fake";
export type Provider = "anthropic" | "deepseek" | "fake";
/** Nano-dollars per token, which is USD per million tokens times 1000. */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ModelInfo = {
  id: string;
  pick: Exclude<ModelPick, "auto">;
  label: string;
  short: string;
  provider: Provider;
  privateOk: boolean;
  price: Price;
  long?: Price & { overPromptTokens: number };
};
export type ModelOption = {
  pick: ModelPick;
  id?: string;
  label: string;
  short: string;
  price: string;
  privateOk: boolean;
};
export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export const ROUTER_MODEL = "claude-haiku-5-5";
export const NAMING_MODEL = "claude-haiku-5-5";

export const JOBS: Record<"run" | "route" | "name", { maxTokens: number; effort: "low" | "medium"; cache: boolean }> = {
  run: { maxTokens: 16_000, effort: "medium", cache: true },
  route: { maxTokens: 1024, effort: "low", cache: false },
  name: { maxTokens: 1024, effort: "low", cache: false },
};

// Prices were read from the providers' pricing pages on 2026-11-11. DeepSeek is always billed at its peak rate.
const MODELS: Record<string, ModelInfo> = Object.fromEntries(
  (
    [
      {
        id: "claude-sonnet-5-5",
        pick: "sonnet",
        label: "Sonnet 5.5",
        short: "Sonnet",
        provider: "anthropic",
        privateOk: true,
        price: { input: 2000, output: 10_000, cacheRead: 100, cacheWrite: 2500 },
      },
      {
        id: "claude-haiku-5-5",
        pick: "haiku",
        label: "Haiku 5.5",
        short: "Haiku",
        provider: "anthropic",
        privateOk: true,
        price: { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
        long: { overPromptTokens: 100_000, input: 500, output: 2500, cacheRead: 50, cacheWrite: 625 },
      },
      {
        id: "claude-opus-5-5",
        pick: "opus",
        label: "Opus 5.5",
        short: "Opus",
        provider: "anthropic",
        privateOk: true,
        price: { input: 4000, output: 20_000, cacheRead: 200, cacheWrite: 5000 },
      },
      {
        // Checked 2026-11-11 on the pricing page; it is not in every model table, so re-check before relying on it.
        id: "claude-fable-5-2",
        pick: "fable",
        label: "Fable 5.2",
        short: "Fable",
        provider: "anthropic",
        privateOk: true,
        price: { input: 8000, output: 40_000, cacheRead: 200, cacheWrite: 10_000 },
      },
      {
        id: "deepseek-flash",
        pick: "deepseek-flash",
        label: "DeepSeek Flash",
        short: "DS Flash",
        provider: "deepseek",
        privateOk: false,
        price: { input: 300, output: 1200, cacheRead: 6, cacheWrite: 300 },
      },
      {
        id: "deepseek-v4-pro",
        pick: "deepseek-pro",
        label: "DeepSeek Pro",
        short: "DS Pro",
        provider: "deepseek",
        privateOk: false,
        price: { input: 1320, output: 3960, cacheRead: 44, cacheWrite: 1320 },
      },
      {
        id: "fake",
        pick: "fake",
        label: "Fake",
        short: "Fake",
        provider: "fake",
        privateOk: true,
        price: { input: 3000, output: 15_000, cacheRead: 3000, cacheWrite: 3000 },
      },
    ] satisfies ModelInfo[]
  ).map((m) => [m.id, m]),
);

export function modelInfo(id: string): ModelInfo {
  const info = MODELS[id];
  if (!info) throw new Error(`Unknown model ${id}`);
  return info;
}

export function priceMicros(id: string, u: TokenUsage): number {
  const { price, long } = modelInfo(id);
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const rate = long && prompt > long.overPromptTokens ? long : price;
  const nano =
    u.inputTokens * rate.input +
    u.outputTokens * rate.output +
    u.cacheReadTokens * rate.cacheRead +
    u.cacheWriteTokens * rate.cacheWrite;
  return Math.ceil(nano / 1000);
}

const usd = (nanoPerToken: number) => {
  const dollars = nanoPerToken / 1000;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
};

export const pickInfo = (pick: Exclude<ModelPick, "auto">): ModelInfo | undefined =>
  Object.values(MODELS).find((m) => m.pick === pick);

const toOption = (m: ModelInfo): ModelOption => ({
  pick: m.pick,
  id: m.id,
  label: m.label,
  short: m.short,
  price: `${usd(m.price.input)} / ${usd(m.price.output)}`,
  privateOk: m.privateOk,
});

/** The picker, in display order; Fake exists only on the local stage. */
export function modelOptions(stage: string): ModelOption[] {
  const models = Object.values(MODELS).filter((m) => m.pick !== "fake" || stage === "local");
  return [{ pick: "auto", label: "Auto", short: "Auto", price: "", privateOk: true }, ...models.map(toOption)];
}
