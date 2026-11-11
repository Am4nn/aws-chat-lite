# Step 5: Model Gateway with Real Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent runs use real models through one gateway:
- **Picker:** Auto · Sonnet · Haiku · Opus · Fable · DeepSeek Flash · DeepSeek Pro, as a pill in the composer. Admins set the room default, and anyone overrides it per message.
- **Auto:** one cheap Haiku router call per run picks Haiku or Sonnet. It leans Sonnet and never picks Opus, Fable or DeepSeek.
- **Privacy:** attachments make a thread private. DeepSeek never receives a private thread, whether by Auto, by the room default or by a manual pick.
- **Cost:** every answer shows the model that answered and what it cost, metered at that model's real rates.
- **Load:** the system holds up under a load test of 25 concurrent fake-model runs plus 100 WebSocket clients on Floci.

**Architecture:**
- **The gateway** is step 4's `ModelGateway`, grown a little:
  - **Chunks:** it gains token usage (including cache reads and writes), an `end` chunk with the stop reason, and the provider's own content for each turn.
  - **`gateway()`** dispatches each request by model to a **provider**: `fake`, `anthropic` or `deepseek`. It prices the usage in one place (`priceMicros`).
- **One adapter, two providers.** Both providers go through `@anthropic-ai/sdk`:
  - **Claude:** a client with `ANTHROPIC_API_KEY`.
  - **DeepSeek:** a client pointed at DeepSeek's Anthropic-compatible endpoint, `<DEEPSEEK_BASE_URL>/anthropic`.

  The adapter smooths over the few gaps DeepSeek's endpoint has.
- **A run keeps one model.** The durable loop's new first step `route` turns the pick into a model id (the router call for Auto) and writes a `routed` event.
- **Native turns.** Each model call appends a `model.turn` event holding the assistant's complete content: thinking blocks, signatures and `tool_use`. `buildContext` hands it back verbatim on the next call, which both Claude and DeepSeek require during a tool round. These events stay in the log, and the SSE stream never sends them.
- **The privacy gate** sits beside the budget check, before every model call. It reads the thread's stored taint plus the taint of the messages that call is about to send, so a steer carrying a file can't slip past while its taint is still being written.
- **Keys** live in one Secrets Manager secret (`cl-<stage>-model-keys`, JSON):
  - **AWS:** the Aman-set secret.
  - **Floci:** `npm run deploy:local -- --live-models` copies the three key values from `.env` into Floci's copy.

  A plain `deploy:local` stays on the fake gateway, so tests and the load test never spend money.

**Tech Stack:** step 4's, plus:
- `@anthropic-ai/sdk` (services; the latest at install time; note the version in the learn doc);
- `@aws-sdk/client-secrets-manager` (services and scripts).

No new web dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-chat-lite-design.md`. Read:
- "Model gateway";
- "Budgets and limits";
- "Agent capabilities";
- "UI and motion";
- "Decisions for steps 3–11" (step 5 and "How the steps are built");
- step 5 in "Proposed steps".

Also read:
- the step 4 plan (`docs/superpowers/plans/2026-11-11-step4-agent-threads.md`), whose interfaces this consumes: `ModelGateway`, `buildContext`, `modelTurn`, `nameThread`, `startOrSteer`, `routeSend`, `finishRun`, `streamRun`, `ThreadSummary`, `RunView`, `RunBlock`, `Composer`;
- the step 4 ledger (`.superpowers/sdd/2026-11-11-step4-agent-threads/progress.md`) for its rulings;
- `docs/learn/floci-compat.md`.

**Prerequisite:** step 4 is merged to master. Cut `step5-model-gateway` from it.

## Global Constraints

- **Steps 1–4 still apply:**
  - `cl-<stage>-` names; chat-lite's own Floci; no VPC/NAT/RDS;
  - the secret scan before every commit, plus the commit trailer;
  - CLAUDE.md and TDD;
  - DynamoDB reserved words only as `#placeholders`;
  - step 3's socket protocol (extended, never changed);
  - integer micro-dollars;
  - the motion rules and honest progress.
  - **Editing files:** use the Edit tool or node, never PowerShell `Set-Content`, which adds BOMs and mojibake.
- **Model IDs (verbatim, no date suffixes):** `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5`, `claude-fable-5-2`, `deepseek-flash`, `deepseek-v4-pro`, plus `fake`.
- **Picks:** stored as stable keys, `auto | sonnet | haiku | opus | fable | deepseek-flash | deepseek-pro`, plus `fake` only where `STAGE=local`.
  - **Labels:** Auto, Sonnet 5.5, Haiku 5.5, Opus 5.5, Fable 5.2, DeepSeek Flash, DeepSeek Pro, Fake.
  - **Phone labels:** Auto, Sonnet, Haiku, Opus, Fable, DS Flash, DS Pro, Fake.
- **Prices** (USD per million tokens):
  - **Sources:** the live Anthropic pricing page, read 2026-11-11, and DeepSeek's pricing page, read the same day.
  - **Stored as:** nano-dollars per token (= USD/MTok × 1000) in `models/catalog.ts`.
  - **Cost of one call:** `ceil(Σ tokens × rate / 1000)` micro-dollars.

  | Model | Input | 5-min cache write | Cache read | Output |
  |---|---|---|---|---|
  | `claude-sonnet-5-5` | 2.00 | 2.50 | 0.10 | 10.00 |
  | `claude-haiku-5-5`, prompt ≤ 100,000 tokens | 0.10 | 0.125 | 0.01 | 0.50 |
  | `claude-haiku-5-5`, prompt > 100,000 tokens (input + cache read + cache write) | 0.50 | 0.625 | 0.05 | 2.50 |
  | `claude-opus-5-5` | 4.00 | 5.00 | 0.20 | 20.00 |
  | `claude-fable-5-2` ⚑ | 8.00 | 10.00 | 0.20 | 40.00 |
  | `deepseek-flash` (peak) | 0.30 | 0.30 | 0.006 | 1.20 |
  | `deepseek-v4-pro` (peak) | 1.32 | 1.32 | 0.044 | 3.96 |
  | `fake` | 3.00 | 3.00 | 3.00 | 15.00 |

  - ⚑ **Fable 5.2 isn't in the claude-api skill's cached model table** (it lists Fable 5.1 at $10/$50). Its price comes from the live pricing page. Keep it a catalog value with the comment "checked 2026-11-11 on the pricing page", and re-check it before the real-key smoke.
  - **Sonnet 5.5's cache read** is $0.10 on the live page against $0.20 in the skill's cache. The live page wins.
  - **DeepSeek** is always charged at peak rates (off-peak is half).
- **Request shape for every Claude call:**
  - no `temperature`, `top_p` or `top_k`;
  - no assistant prefill: `messages` must end on a user turn;
  - no forced `tool_choice` (400 on the 5.5 models; leave it unset);
  - `thinking` left unset (adaptive; Opus 5.5 and Fable can't turn it off), so thinking text stays omitted;
  - `eager_input_streaming` off.
- **Jobs** (`JOBS` in `models/catalog.ts`):

  | Job | Model | `max_tokens` | `effort` | Prompt cache |
  |---|---|---|---|---|
  | `run` | the routed model | **16,000** | `medium` (Claude); unset for DeepSeek | top-level `cache_control: {type:"ephemeral"}` (Claude only) |
  | `route` | `claude-haiku-5-5` | **1,024** | `low` | none |
  | `name` | `claude-haiku-5-5` | **1,024** | `low` | none |
- **Auto:**
  - **Input:** the run's first message, ≤ **4,000** characters.
  - **Answer:** a one-word reply. Exactly `haiku` (case and surrounding punctuation ignored) → Haiku; anything else, an error, a refusal or a budget at its cap → Sonnet.
  - **Never** Opus, Fable or DeepSeek.
- **Privacy:** `TaintSource = "attachment"` for now; the set only grows. A thread is private once any of its messages has an attachment, and stays private. Models with `privateOk: false`: `deepseek-flash`, `deepseek-v4-pro`.
  - **A manual DeepSeek pick on a private thread, or with a file:** refused at send, before anything is stored, with `PICK_REFUSED` = "This has private content (attachments), so DeepSeek is off here. Pick another model."
  - **A room default of DeepSeek on a private thread:** becomes Auto.
  - **Private content reaching a DeepSeek run:** the run ends `failed` with `RUN_REFUSED` = "This thread now has private content (attachments), so DeepSeek stopped. Send again with another model."
  - **Small jobs** (route, name) always run on Haiku.
- **Run ending copy:**
  - **A cut-off answer:** `LENGTH_NOTE` = "\n\n(The answer was cut off at the length limit.)" is appended, and the run closes `done`.
  - **A refusal:** "The model declined this request. Try another model." (`failed`).
  - **A drop mid-answer:** "The model's connection dropped mid-answer." (`failed`).
- **Tool names** sent to a provider must match `^[a-zA-Z0-9_-]{1,64}$`. The adapter throws otherwise. Real models get **no tools** in this step; `FAKE_TOOLS` go only to a fake-served model.
- **Keys:**
  - **Where:** only in the secret JSON `{ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL}` or the gitignored `.env`.
  - **Never** in a template, a Lambda environment variable, a log line, an event or git.
  - **Scripts** print key *names*, never values.
  - **DeepSeek's base URL** is `<DEEPSEEK_BASE_URL without a trailing / or /v1>/anthropic`.
- **Real-key spend:**
  - **Total cap:** **$3** across the whole step.
  - **The live suite:** `npm -w services run test:live`, opt-in with `REAL_MODELS=1`, never part of `npm test`. Each run stops itself at **$0.50** of metered spend, prints its spend, and runs **at most 3 times** in total. Record each run's spend in the ledger.
  - **Load and int tests:** always on the fake gateway.
- **Load test:** **25** concurrent runs + **100** WebSocket clients (10 users × 10 sockets) in one room on Floci, with the fake gateway.
- **Floci is shared.** Parallel tasks take turns at their `deploy:local` + int-test steps; only one task deploys at a time.

### Shared contract (pinned; every task uses these exact shapes)
```ts
// services/src/models/catalog.ts (Task 1)
export type ModelPick = "auto" | "sonnet" | "haiku" | "opus" | "fable" | "deepseek-flash" | "deepseek-pro" | "fake";
export type Provider = "anthropic" | "deepseek" | "fake";
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }; // nano-USD per token
export type ModelInfo = { id: string; pick: Exclude<ModelPick, "auto">; label: string; short: string; provider: Provider;
  privateOk: boolean; price: Price; long?: Price & { overPromptTokens: number } };
export type ModelOption = { pick: ModelPick; id?: string; label: string; short: string; price: string /* "$2 / $10", "" for Auto */; privateOk: boolean };
export type TokenUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
// services/src/models/privacy.ts (Task 1)
export type TaintSource = "attachment";

// services/src/models/gateway.ts (Task 3; replaces step 4's chunk and request types)
export type NativeTurn = { model: string; content: unknown };          // the provider's assistant content, verbatim
export type ModelMessage =
  | { role: "user"; author: string; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[]; native?: NativeTurn }
  | { role: "tool"; toolCallId: string; output: string; isError?: boolean };
export type ModelRequest = { model: string; system: string; messages: ModelMessage[]; tools: ToolSpec[];
  maxTokens: number; effort?: "low" | "medium"; cache?: boolean; signal?: AbortSignal };
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "aborted";
export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | ({ type: "usage" } & TokenUsage)
  | { type: "end"; stop: StopReason; native?: NativeTurn };            // always the last chunk
export type ModelChunk = Exclude<ProviderChunk, { type: "usage" }> | ({ type: "usage"; costMicros: number } & TokenUsage);
export interface ModelProvider { stream(req: ModelRequest): AsyncIterable<ProviderChunk> }
export interface ModelGateway { stream(req: ModelRequest): AsyncIterable<ModelChunk>; servedBy(model: string): Provider }

// services/src/threads/types.ts (Task 5) — mirrored in web/lib/types.ts (Task 2)
ThreadSummary += { taint: TaintSource[] }                                 // sorted, [] when none
RoomView      += { defaultModel: ModelPick; models: ModelOption[] }
RunEventBody:
  | { type: "run.started"; pick: ModelPick; startedBy: string }           // `model` renamed to `pick`
  | { type: "routed"; model: string; by: "pick" | "default" | "auto" }    // once per run, before any run model call
  | { type: "model.turn"; model: string; content: unknown }               // after each run model call that ended; never streamed
  | { type: "usage"; model: string; job: "route" | "name" | "run" } & TokenUsage & { costMicros: number }
Message.agent += { pick: ModelPick }                                      // agent.model is now the model id that answered
Run (META)    += { pick: ModelPick; pickBy: "pick" | "default"; model?: string }   // model set by the route step
// client → server: send {…, model?: ModelPick}; POST /rooms/{roomId}/threads {text, clientId, model?}
// HTTP: PUT /rooms/{roomId}/model {model} → {defaultModel}; owner/admin, else 403; broadcasts {type:"room.updated", roomId}
// Room META += defaultModel (absent = "auto"); THREAD item += taint (a DynamoDB string set, ADD-only)
```

## Review Focus
1. **Private content never reaches DeepSeek.** Three routes have to stay closed:
   - a steer carrying a file that lands mid-run, before the thread's taint is stored;
   - a room default of DeepSeek on a private thread;
   - a manual DeepSeek pick with a file.

   Expected: the steer ends the run with `RUN_REFUSED` and no DeepSeek `usage` event after the steer; the default becomes Auto; the pick is refused before anything is stored. Pinned in Task 1 (rules), Task 5 (send refusal; default → Auto) and Task 6 (the gate reads the context's own messages).
2. **A model call that fails mid-answer doesn't duplicate the answer.** A durable retry of a model step that already streamed text would append that text twice. A failure after the first text event ends the run `failed`, keeping the partial text once; a failure before any text retries. Pinned in Task 3 (the fake `drop:N`) and Task 6 (the headline appears exactly once).
3. **A tool round replays exactly what the model sent.** The assistant's native content (thinking + `tool_use`) goes back verbatim to the same model. Every `tool_use` gets its `tool_result` in the next user message, before any steer text. A leading or trailing assistant turn, or an empty text block, is never sent. Pinned in Task 4 (`toMessages`), Task 6 (`model.turn` → `native`) and Task 9 (a real tool round on every model).
4. **Cost is the provider's bill, rounded up, never lost.** Billing covers:
   - cache reads and writes;
   - Haiku's > 100,000-token card, with cache tokens counting toward the threshold;
   - DeepSeek at peak;
   - a stopped stream: input from `message_start` plus estimated output.

   Under 25 concurrent runs, the room's month usage equals the sum of the runs' costs. Pinned in Task 1 (`priceMicros`), Task 4 (usage mapping, abort) and Task 8 (the load-test sum).
5. **Auto stays in its lane.** A router reply of `opus`, `fable`, `deepseek`, a sentence or nothing → Sonnet; a router error → Sonnet. A manual Opus pick makes no router call. Pinned in Task 1 (`parseRoute`) and Task 6 (`route:opus` → Sonnet; Opus pick → no `job:"route"` usage).

---

### Task 1: Catalog, pricing, picks, router parsing and the privacy rule (pure, services) [wave 1, parallel]

**Files:**
- Create: `services/src/models/catalog.ts`, `services/src/models/picks.ts`, `services/src/models/privacy.ts`, with a `*.test.ts` beside each

**Interfaces:**
- Produces, in `catalog.ts`:
  - the shared-contract types;
  - `MODELS: Record<string, ModelInfo>` keyed by id, with the prices table above;
  - `ROUTER_MODEL = NAMING_MODEL = "claude-haiku-5-5"`;
  - `JOBS: Record<"run" | "route" | "name", {maxTokens: number; effort: "low" | "medium"; cache: boolean}>`;
  - `modelInfo(id): ModelInfo`: throws `Unknown model <id>`;
  - `priceMicros(id: string, u: TokenUsage): number`: uses `long` when input + cacheRead + cacheWrite > `overPromptTokens`;
  - `modelOptions(stage: string): ModelOption[]`: in picker order; Fake last and only for `"local"`.
- Produces, in `picks.ts`:
  - `parsePick(raw: unknown, stage: string): ModelPick | undefined`: undefined/null → undefined; otherwise `ValidationError("Unknown model.")` from `lib/errors.ts`;
  - `resolvePick(pick: ModelPick | undefined, roomDefault: ModelPick, taint: TaintSource[]): {pick: ModelPick; by: "pick" | "default"}`;
  - `modelIdOf(pick: Exclude<ModelPick, "auto">): string`;
  - `ROUTER_PROMPT`: exact copy, "Pick the model for this team-chat request. Reply with one word. haiku: greetings, small talk, quick facts, short rewrites or summaries. sonnet: code, debugging, tools, analysis, planning, or anything with several steps. If unsure, reply sonnet.";
  - `routerInput(text): string`;
  - `parseRoute(reply: string): "claude-haiku-5-5" | "claude-sonnet-5-5"`.
- Produces, in `privacy.ts`:
  - `TaintSource`, `PICK_REFUSED`, `RUN_REFUSED`;
  - `messageTaint(m: {attachments?: unknown[]}): TaintSource[]`;
  - `mergeTaint(...lists: TaintSource[][]): TaintSource[]`: sorted and unique;
  - `pickRefusal(pick: ModelPick | undefined, taint: TaintSource[]): string | null`;
  - `runRefusal(modelId: string, taint: TaintSource[]): {status: "failed"; reason: string} | null`.
  - The copy reads "attachments" via `TAINT_WORDS: Record<TaintSource, string>`, so a new source only adds a word.

- [ ] **Step 1: Write failing tests**
  - **`priceMicros`:**
    - Sonnet `{in 1000, out 500}` → 7,000;
    - Sonnet `{in 100, cacheRead 10_000, cacheWrite 2_000, out 0}` → 6,200;
    - Haiku `{in 100_000, out 1000}` → 10,500; `{in 100_001, out 1000}` → 52,501; `{in 1, cacheRead 100_000}` → 5,001 (the long card, from the cache tokens);
    - Haiku `{in 1}` → 1 (rounds up);
    - `deepseek-flash` 1M in + 1M out → 1,500,000; `deepseek-v4-pro` → 5,280,000; `claude-fable-5-2` → 48,000,000; `claude-opus-5-5` → 24,000,000;
    - `fake` `{in 10, out 5}` → 105;
    - `"gpt-5"` throws.
  - **`modelOptions`:**
    - `modelOptions("aws").map(o => o.pick)` equals `["auto","sonnet","haiku","opus","fable","deepseek-flash","deepseek-pro"]`;
    - `"local"` adds `"fake"` last;
    - Sonnet's price is `"$2 / $10"`; Auto's is `""` with no `id`;
    - both DeepSeeks have `privateOk:false`.
  - **`parsePick`:** `"opus"` → `"opus"`; `undefined` → `undefined`; `"fake"` on `"aws"` and `"gpt-5"` throw `"Unknown model."`; `"fake"` on `"local"` → `"fake"`.
  - **`resolvePick`:**
    - `(undefined, "deepseek-flash", ["attachment"])` → `{pick:"auto", by:"default"}`;
    - `(undefined, "opus", [])` → `{pick:"opus", by:"default"}`;
    - `("haiku", "opus", [])` → `{pick:"haiku", by:"pick"}`.
  - **`parseRoute`:**
    - `"haiku"`, `"Haiku."` and `"  haiku\n"` → Haiku;
    - `"sonnet"`, `"opus"`, `"fable"`, `"deepseek"`, `""` and `"haiku or sonnet"` → Sonnet.
  - **`routerInput`:** 5,000 chars → 4,000.
  - **Privacy:**
    - `messageTaint({attachments:[{}]})` → `["attachment"]`; `[]` and a missing field → `[]`;
    - `pickRefusal`: `("deepseek-flash", ["attachment"]) === PICK_REFUSED`; `("sonnet", ["attachment"])`, `("deepseek-flash", [])`, `("auto", ["attachment"])` and `(undefined, ["attachment"])` → null;
    - `runRefusal`: `("deepseek-v4-pro", ["attachment"])` → `{status:"failed", reason: RUN_REFUSED}`; `("claude-sonnet-5-5", ["attachment"])` → null;
    - the copy strings equal the Global Constraints verbatim.
- [ ] **Step 2: Run** `npm -w services test -- models`. Expected: FAIL (missing modules).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(models): model catalog with real prices, picks, the Auto router's reply rule and the privacy rule`.

### Task 2: Web model logic: contract mirror, pick menu, answer footer, reducer (pure) [wave 1, parallel]

**Files:**
- Create: `web/lib/client/models.ts`, `web/lib/client/models.test.ts`
- Modify: `web/lib/types.ts` (the shared-contract mirror), `web/lib/client/run.ts` and its test

**Interfaces:**
- Produces:
  - **`pickMenu(models: ModelOption[], s: {value: ModelPick; roomDefault: ModelPick; taint: TaintSource[]; isAdmin: boolean}) → {items: {pick; label; price; selected; isDefault; disabled}[]; privateNote: boolean; canSetDefault: boolean}`:**
    - `disabled` = `!privateOk && taint.length > 0`;
    - `canSetDefault` = `isAdmin && value !== roomDefault`.
  - **`nextEnabled(items, from: number, dir: 1 | -1): number`:** wraps and skips disabled items.
  - **`pillLabel(models, pick, phone: boolean): string`.**
  - **`modelLabel(models, id): string`:** the option's label, else the id itself.
  - **`footerText(agent: {model; pick; costMicros; ms}, models): string`:**
    - Auto: `Auto → <label> · <formatUsd> · <formatElapsed>`;
    - otherwise: `<label> · …`.
  - **`RunView`** gains `pick?: ModelPick`:
    - `run.started` sets `pick`;
    - `routed` sets `model`;
    - `model.turn` is ignored;
    - every `usage` (any `job`) adds to `costMicros`.

- [ ] **Step 1: Write failing tests**
  - **`pickMenu`:**
    - with taint `["attachment"]`, both DeepSeek items are disabled and `privateNote` is true;
    - with no taint, none are disabled;
    - room default `"opus"` → only Opus has `isDefault`;
    - `canSetDefault`: true for an admin with value `"haiku"` and default `"auto"`; false for a member; false when value === default.
  - **`nextEnabled`:** from Opus (index 3) going down, with DeepSeek disabled, Fable is next (4), then it wraps to Auto (0).
  - **`pillLabel`:** `(…, "deepseek-flash", true) === "DS Flash"`, `(…, "sonnet", false) === "Sonnet 5.5"`.
  - **`footerText`:**
    - `{model:"claude-sonnet-5-5", pick:"auto", costMicros:42_000, ms:12_000}` → `"Auto → Sonnet 5.5 · $0.04 · 0:12"`;
    - `pick:"opus"`, `model:"claude-opus-5-5"` → `"Opus 5.5 · $0.04 · 0:12"`;
    - an unknown id `"x"` → `"x · $0.04 · 0:12"`.
  - **Reducer:**
    - `run.started{pick:"auto"}` then `routed{model:"claude-haiku-5-5"}` → `pick:"auto"`, `model:"claude-haiku-5-5"`;
    - two `usage` events (`job:"route"` 100, `job:"run"` 900) → `costMicros` 1000;
    - a `model.turn` event changes nothing but `lastSeq`.
- [ ] **Step 2: Run** `npm -w web test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): model pick menu rules, answer footer with model and cost, routed runs in the reducer`.

### Task 3: Gateway contract, fake model and the metered dispatcher (services) [wave 2, after Task 1]

**Files:**
- Modify: `services/src/models/gateway.ts` (the shared contract), `fake.ts`, `fake.test.ts`, `index.ts`
- Create: `services/src/models/index.test.ts`

**Interfaces:**
- Consumes: Task 1's `MODELS`, `priceMicros`, `ROUTER_PROMPT`.
- **`fakeModel({sleep}): ModelProvider`.** Step 4's behaviour, plus:
  - **Usage:** fills `cacheReadTokens` and `cacheWriteTokens` with 0, carries no `costMicros`, and comes second-to-last.
  - **The last chunk** is always `end`: `stop` is `"tool_use"` after a tool call, `"end_turn"` after an answer, `"aborted"` on abort. `native` is `{model: req.model, content: {fake: true, calls: [ids]}}`, except on abort.
  - **`system === ROUTER_PROMPT`:** the reply is the word after `route:` in the first user message, else `"sonnet"`.
  - **New directives** (stripped from the query like the others):
    - `drop:N`: N answer words, then it throws `"fake connection dropped"`;
    - `cutoff`: one `tool_call`, then `end` with `stop:"max_tokens"`;
    - `refuse`: no text, then `end` with `stop:"refusal"`.
- **`gateway(env = process.env, providers?: {anthropic: ModelProvider; deepseek: ModelProvider}): ModelGateway`:**
  - **`servedBy(model)`:** `MODEL_GATEWAY=fake` → `"fake"` for every model; `MODEL_GATEWAY=live` → `modelInfo(model).provider`; anything else throws `Unknown model gateway`.
  - **`stream`:** sends the request to that provider and replaces each provider `usage` with one that carries `costMicros = priceMicros(req.model, usage)`.

    The fake therefore bills a real model id at that model's rates, and `fake` at $3/$15.
  - **Live with no `providers`:** it throws `"Live models aren't wired here."` (Task 4 supplies them).

- [ ] **Step 1: Write failing tests**
  - **Update step 4's fake tests:**
    - chunk lists end `…, usage, end`;
    - the 40/20-char case gives usage `{inputTokens:10, outputTokens:5, cacheReadTokens:0, cacheWriteTokens:0}`;
    - through `gateway({MODEL_GATEWAY:"fake"})` with `model:"fake"`, `costMicros` is 105.
  - **New:**
    - **Sonnet pricing:** `gateway({MODEL_GATEWAY:"fake"})` streaming `claude-sonnet-5-5` → `costMicros === priceMicros("claude-sonnet-5-5", usage)`.
    - **Stop reasons and native:** a tool turn's `end` → `{stop:"tool_use", native.model:"claude-sonnet-5-5"}`; an answer's → `end_turn`.
    - **Abort:** usage, then `end{stop:"aborted"}` with no native.
    - **Router:** `ROUTER_PROMPT` on `"route:haiku hi"` → text `"haiku"`; on `"go"` → `"sonnet"`; on `"route:opus x"` → `"opus"`.
    - **`drop:3 words:10`:** 3 answer-word chunks after the headline, then it throws `"fake connection dropped"`.
    - **`cutoff`:** a `tool_call`, then `end{stop:"max_tokens"}`.
    - **`refuse`:** `[usage, end{stop:"refusal"}]` with no text.
    - **`servedBy`:**
      - fake env → `"fake"` for `claude-opus-5-5`;
      - `{MODEL_GATEWAY:"live"}` → `"anthropic"` for `claude-haiku-5-5`, `"deepseek"` for `deepseek-flash`, `"fake"` for `fake`;
      - `{MODEL_GATEWAY:"openai"}` throws.
- [ ] **Step 2: Run** `npm -w services test -- models`. Expected: FAIL.
- [ ] **Step 3: Implement.** `runs/steps.ts` still compiles: it keeps reading `chunk.costMicros` and ignores `end`. Pass `maxTokens: JOBS.run.maxTokens` there, so the type checks.
- [ ] **Step 4: Run** `npm -w services test && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(models): metered gateway dispatch by provider; the fake model reports stop reasons, native turns and router replies`.

### Task 4: The Anthropic-compatible adapter, keys and the real-key suite [wave 3, after Task 3; parallel with Task 5]

**Files:**
- Create:
  - `services/src/models/anthropic.ts`, `anthropic.test.ts`, `keys.ts`, `keys.test.ts`, `anthropic.live.test.ts`;
  - `services/vitest.live.config.ts`.
- Modify:
  - `services/src/models/index.ts`: `liveProviders()`;
  - `services/vitest.config.ts`: exclude `*.live.test.ts` and `*.load.test.ts`;
  - `services/package.json`: `@anthropic-ai/sdk`, `@aws-sdk/client-secrets-manager`, `"test:live": "vitest run --config vitest.live.config.ts"`;
  - `infra/lib/config.ts` (+ test): `modelGateway`;
  - `infra/lib/runs.ts` (+ test): the secret and the env;
  - `scripts/src/deploy-local.ts`: `--live-models`;
  - `scripts/package.json`: secrets-manager;
  - `knip.json`: services entry `src/**/*.live.test.ts`;
  - `docs/learn/floci-compat.md`.

**Interfaces:**
- Consumes: Task 3's contract and Task 1's `modelInfo`, `JOBS`.
- **`toParams(req: ModelRequest, kind: "anthropic" | "deepseek"): Anthropic.MessageStreamParams`:**
  - `{model, max_tokens: maxTokens, system, messages: toMessages(...), tools}`;
  - `tools` = `[{name, description, input_schema}]`, omitted when empty;
  - **Claude only:** `output_config: {effort}` when set, and `cache_control: {type:"ephemeral"}` when `cache`;
  - **never:** `thinking`, sampling parameters or `tool_choice`;
  - **tool names:** an invalid one → throw `"Tool names must match ^[a-zA-Z0-9_-]{1,64}$ (got <name>)"`.
- **`toMessages(messages, model, kind): Anthropic.MessageParam[]`** (the algorithm the types don't determine):
  1. **Each message:**
     - **user** → the text block `"<author>: <text>"`;
     - **tool** → `{type:"tool_result", tool_use_id, content: output, is_error}`. DeepSeek ignores `is_error`, so for `kind === "deepseek"` an error's content is prefixed `"Tool error: "`;
     - **assistant with `native.model === model`** → `content: native.content`, untouched;
     - **any other assistant** → `[text?, ...tool_use{id, name, input}]`, without empty text.
  2. **Drop** empty text blocks, and any message left with no content.
  3. **Merge** consecutive same-role messages in order, so tool results come first and a steer's text follows them.
  4. **Trim the ends:** drop leading assistant messages, and drop a trailing assistant message, which would be a prefill.
- **`anthropicProvider(client: Pick<Anthropic, "messages">, kind): ModelProvider`** streams `client.messages.stream(toParams(req, kind), {signal: req.signal})`:
  - **While streaming:** each `content_block_delta` `text_delta` → a `text` chunk.
  - **At the end:** from `await stream.finalMessage()`:
    - each `tool_use` block → `tool_call {id, name, input}`;
    - usage → `{inputTokens: input_tokens, outputTokens: output_tokens, cacheReadTokens: cache_read_input_tokens ?? 0, cacheWriteTokens: cache_creation_input_tokens ?? 0}`;
    - `end {stop, native: {model: req.model, content: final.content}}`.
  - **Stop mapping:** `end_turn`, `tool_use`, `max_tokens` and `refusal` map to themselves; any other value → `end_turn`.
  - **On `Anthropic.APIUserAbortError`:**
    - usage = the input fields from the `message_start` event, with `outputTokens = ceil(streamed chars / 4)`;
    - then `end {stop:"aborted"}`.
  - **Other errors** are rethrown.
- **`modelKeys(env = process.env, read = readSecretJson): Promise<{anthropicKey?: string; deepseekKey?: string; deepseekBaseUrl?: string}>`:**
  - **Source:** `MODEL_KEYS_SECRET` set → read that secret once per container (cached); otherwise straight from `env`.
  - **`deepseekBaseUrl(base)`:** strips a trailing `/` and `/v1`, appends `/anthropic`, and leaves a URL already ending in `/anthropic` unchanged.
- **`liveProviders(keys)`:**
  - `anthropic` = `new Anthropic({apiKey})`;
  - `deepseek` = `new Anthropic({apiKey, baseURL})`;
  - **a missing key** → a provider whose `stream` throws `"Claude isn't set up here (no ANTHROPIC_API_KEY)."` / `"DeepSeek isn't set up here (no DEEPSEEK_API_KEY)."`.

  `gateway()` in live mode awaits `modelKeys()` on its first stream.
- **Infra:**
  - `StageConfig.modelGateway`: `"fake" | "live"`. Local = `env.MODEL_GATEWAY === "live" ? "live" : "fake"`; aws = `"live"`.
  - `addRuns` creates `secretsmanager.Secret` `cl-<stage>-model-keys` (its value is set out of band), runs `grantRead(runFn)`, and sets the env `MODEL_GATEWAY` and `MODEL_KEYS_SECRET` (the secret's name).
- **`deploy:local -- --live-models`:**
  - passes `MODEL_GATEWAY=live` to `cdk`;
  - after the deploy, reads `.env` with `node:util` `parseEnv` and `PutSecretValue`s the three keys into Floci's `cl-local-model-keys`;
  - prints `model keys stored in Floci: ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL`;
  - a missing key → exit 1, naming it.

- [ ] **Step 1: Write failing tests** (a hand-built fake client that replays recorded stream events; no network)
  - **`toParams`:**
    - Sonnet run → `max_tokens:16000`, `output_config:{effort:"medium"}`, `cache_control:{type:"ephemeral"}`; none of the keys `thinking`, `temperature`, `top_p`, `top_k` or `tool_choice`;
    - `kind:"deepseek"` → no `output_config` and no `cache_control`;
    - a tool named `fake.lookup` → throws.
  - **`toMessages`:**
    - two prior users (aman "hi", bea "and") → one user message with two text blocks `"aman: hi"`, `"bea: and"`;
    - a leading assistant is dropped; a trailing assistant is dropped; an empty user text is dropped;
    - an assistant with `native {model: same}` → `content` deep-equals `native.content`; with `native {model: other}` → `[tool_use]` only, when its text is empty;
    - **a tool round:** `[user, assistant{toolCalls:[c1,c2]}, tool c1, tool c2 isError, user bea "also"]` → 3 messages, the last `[tool_result c1, tool_result c2 (is_error:true), text "bea: also"]`;
    - for DeepSeek, c2's content starts `"Tool error: "`.
  - **Streaming:**
    - text deltas `"Hel"`, `"lo"` → two `text` chunks;
    - a final message with a `tool_use` → a `tool_call` with an object `input`;
    - usage `{input_tokens:12, output_tokens:34, cache_read_input_tokens:5, cache_creation_input_tokens:6}` → `{12,34,5,6}`; null cache fields → 0;
    - `end` → `{stop:"tool_use", native:{model, content: final.content}}`;
    - `stop_reason:"pause_turn"` → `end_turn`.
  - **Abort:** aborted after 2 deltas (8 chars), `message_start` input 20 → usage `{inputTokens:20, outputTokens:2}`, then `end{stop:"aborted"}`.
  - **Errors:** a mid-stream `APIConnectionError` rejects the iterator.
  - **Keys:**
    - `deepseekBaseUrl` on `https://api.deepseek.com`, `…com/`, `…com/v1` and `…com/anthropic` → `https://api.deepseek.com/anthropic`;
    - with `MODEL_KEYS_SECRET`, two `modelKeys` calls → `read` called once;
    - with no keys, `liveProviders({}).anthropic.stream(…)` rejects with the Claude copy.
  - **Infra:**
    - the run function's env has `MODEL_GATEWAY:"fake"` by default and `"live"` with `MODEL_GATEWAY=live`, plus `MODEL_KEYS_SECRET`;
    - its role may `secretsmanager:GetSecretValue` on that secret;
    - no Lambda env var name matches `/API_KEY/`.
  - **The live suite (`anthropic.live.test.ts`):** `describe.skipIf(!process.env.REAL_MODELS)`; the config loads the repo `.env` with `process.loadEnvFile`. For each of the 6 real models, with `maxTokens:1024` and effort `low` (Claude):
    1. `"Reply with the word ok."` → the text contains `ok` (case-insensitive) and `costMicros > 0`;
    2. **a tool round** with the tool `get_number` (`{}` → `"42"`). The model calls it; the next request replays `native` + `tool_result`; the final text contains `42`.

    Plus the router on Haiku:
    - `"hi"` → `parseRoute` = Haiku;
    - `"Refactor the auth module and add tests for it"` → Sonnet.

    A shared meter throws once the suite's spend passes 500,000 micros. `afterAll` prints `real-model spend: $<x>`.
- [ ] **Step 2: Run** `npm -w services test -- anthropic keys && npm -w infra test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Check Floci:
  - Does Floci accept the CDK `Secret`, and can a Floci Lambda `GetSecretValue` it?
  - Can a Floci Lambda reach `api.anthropic.com`? Check with `--live-models` + one `test:int`-style call, or wait for Task 9's hand run.

  Note both in `floci-compat.md`. If Floci lacks Secrets Manager: `--live-models` instead sets the three values as the run function's env with `UpdateFunctionConfiguration` after the deploy (never in the template). `modelKeys` already falls back to `env`. Note that in `floci-compat.md`.
- [ ] **Step 4: Run** `npm test && npm run check`. Expected: PASS, with the live suite skipped. Then, once and only now, `REAL_MODELS=1 npm -w services run test:live` (PowerShell: `$env:REAL_MODELS='1'; npm -w services run test:live`).
  - Expected: all pass, and the printed spend is ≤ $0.50. Record it in the ledger.
  - A Fable 5.2 failure on request shape: compare it with the claude-api skill's Fable 5.1 rules, fix, and use one more of the 3 allowed runs.
- [ ] **Step 5: Commit** `feat(models): Claude and DeepSeek through one Anthropic SDK adapter, keys from Secrets Manager, opt-in real-model suite`.

### Task 5: Picks and taint through the app: send, threads, room default [wave 3, after Task 1; parallel with Task 4]

**Files:**
- Modify:
  - `services/src/threads/types.ts`: the whole shared-contract block, including `RunEventBody` and `Message.agent.pick`;
  - `services/src/threads/model.ts`: `summary()` returns `taint` sorted from the string set, else `[]`;
  - `services/src/threads/route.ts` (+ test), `services/src/threads/handler.ts` (+ test);
  - `services/src/runs/start.ts`, `services/src/runs/repo.ts`: `Run` gains `pick`, `pickBy` and `model?`;
  - `services/src/chat/actions.ts`: `send` passes `model`;
  - `services/src/rooms/access.ts` (+ test): `can("setModel")` for owner and admin;
  - `services/src/rooms/repo.ts`: `getRoomView` gains `defaultModel` and `models`, and there's a new `setDefaultModel`;
  - `services/src/rooms/handler.ts` (+ test);
  - `infra/lib/rooms.ts` (+ test);
  - `services/src/runs/repo.int.test.ts`, `services/src/live/live.int.test.ts`.

**Interfaces:**
- Consumes: Task 1's `parsePick`, `resolvePick`, `pickRefusal`, `messageTaint`, `mergeTaint`, `modelOptions`.
- **`routeSend(user, input & {model?: unknown})`:** `pick = parsePick(input.model, STAGE)`. Before `chat.send`, when the message goes to an agent (own thread, delivery target or `@agent`), it checks `pickRefusal(pick, mergeTaint(target?.taint ?? [], messageTaint(admitted)))`. A non-null result throws `ValidationError(<copy>)`, the ack is `ok:false`, and nothing is stored. The pick is handed to `startOrSteer`.
- **`startOrSteer(user, roomId, threadId, message, pick?: ModelPick)`:**
  - **Reads:** the room META's `defaultModel` (absent = `"auto"`).
  - **A new run:** gets `{pick, pickBy} = resolvePick(pick, roomDefault, mergeTaint(thread.taint, messageTaint(message)))`, and `run.started` carries `pick`.
  - **Taint:** when `messageTaint(message)` is non-empty, both the claim update and the steer update add `ADD #taint :t` (a string set). The summary that `notifyRun` sends then carries `taint`.
  - **A steer:** its pick is ignored.
- **`POST /rooms/{roomId}/threads {text, clientId, model?}`:** the same `parsePick` + `pickRefusal` before storing, then `startOrSteer(…, pick)`.
- **`roomsRepo().setDefaultModel(user, roomId, pick) → ModelPick`:** owner/admin (`Forbidden` otherwise); `SET defaultModel` on room META. The handler for `PUT /rooms/{roomId}/model {model}`:
  - checks `parsePick(model, STAGE)` and rejects undefined → 400;
  - then broadcasts `room.updated`;
  - and returns `{defaultModel}`.
- **`getRoomView`:** `defaultModel` (default `"auto"`) and `models: modelOptions(STAGE)`.

- [ ] **Step 1: Write failing tests**
  - **Unit (fake repos):**
    - `PUT /rooms/r/model {model:"gpt"}` → 400; as a member → 403; as an admin with `"haiku"` → 200 `{defaultModel:"haiku"}`, plus one `room.updated` broadcast;
    - `POST /rooms/r/threads {model:"deepseek-pro"}` on a thread-less room with text only → 201.
  - **Repo int:**
    - **Attachment taint:** `startOrSteer` with a message carrying an attachment → the thread's `taint` is `["attachment"]`, and the RUN META has `pick:"auto"`, `pickBy:"default"`.
    - **Explicit pick:** `pick:"opus"` → `pick:"opus"`, `pickBy:"pick"`.
    - **Room default, private thread:** room default `"deepseek-flash"` on a private thread → `pick:"auto"`, `pickBy:"default"`.
    - **Steer taint:** a steer carrying an attachment into a running thread adds the taint and leaves the run's pick unchanged.
    - **Room view:** `getRoomView` → `defaultModel:"auto"` until set; then `"haiku"`.
  - **Socket int:**
    - in a private thread, a send with `model:"deepseek-flash"` → ack `ok:false` with `PICK_REFUSED`, and the thread history length is unchanged;
    - in #general, `"@agent look"` with an attachment and `model:"deepseek-pro"` → refused, with no new thread or message;
    - the same with `model:"sonnet"` → ok, and the new thread is private.
  - **Infra:** `PUT /rooms/{roomId}/model` exists with the JWT authorizer.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** Update step 4's tests that read `run.started.model` so they read `pick`.
- [ ] **Step 4: Run** `npm test && npm run deploy:local && npm -w services run test:int`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(models): per-message picks and the room default, private threads from attachments, DeepSeek refused at send`.

### Task 6: The run engine on real models: route step, privacy gate, native turns, stop reasons [wave 4, after Tasks 3 and 5]

**Files:**
- Modify:
  - `services/src/runs/steps.ts`, `loop.ts`;
  - `context.ts` (+ `context.test.ts`): native turns and attachment names;
  - `stream.ts` (+ `stream.test.ts`): `model.turn` is never sent;
  - `services/src/runs/run.int.test.ts`.

**Interfaces:**
- Consumes: Tasks 1, 3 and 5.
- **`routeRun(run) → {model: string; costMicros: number}`**, the durable step `"route"`, run before `"name"`:
  - **The model:**
    - `pick !== "auto"` → `modelIdOf(pick)`, by `pickBy`;
    - `"auto"` with the budget under its cap → one `ROUTER_MODEL` call (`JOBS.route`, `ROUTER_PROMPT`, a single user message `routerInput(first message text)`) → `parseRoute`, by `"auto"`;
    - a thrown error or `stop:"refusal"` → Sonnet.
  - **The router call** is metered as `usage{job:"route"}`.
  - **Writes:** the `routed` event, then RUN META `model`.
  - The loop carries `run.model` from the step's result.
- **`nameThread`:** uses `NAMING_MODEL` and `JOBS.name`; its usage has `job:"name"`.
- **`modelTurn(run)`**, after `limitsReached` and reading steers, before the call:
  - **The privacy gate:**
    - `taint = mergeTaint(thread.taint (fresh, consistent read), ...prior.map(messageTaint), ...unread.map(messageTaint))`;
    - `runRefusal(run.model, taint)` → return its `end`.
  - **The request:** `{model: run.model, …JOBS.run}`, with `tools` = `FAKE_TOOLS` when `gateway().servedBy(run.model) === "fake"`, else `[]`.
- **`stream(…)` handles `end`:**
  - **`native`** → append `{type:"model.turn", model, content}` after the text flush;
  - **`stop:"max_tokens"`** → don't run the turn's tool calls; append the `LENGTH_NOTE` text event; end `{status:"done"}`;
  - **`stop:"refusal"`** → end `failed` with the refusal copy;
  - **a thrown error:**
    - after **this attempt** wrote a `text` event → end `failed` "The model's connection dropped mid-answer.", and the step returns normally, so it isn't retried;
    - before any → rethrow, so the durable retry runs.
- **`buildContext`:**
  - a `model.turn` event sets `native` on the current assistant message;
  - a prior user message's text gains one `\n[attached: <name>]` line per attachment;
  - `routed` and `usage` are ignored.
- **`streamRun`** skips `model.turn` events, still advancing its cursor past them.

- [ ] **Step 1: Write failing tests**
  - **Unit:**
    - **`buildContext`:** `[text "a", model.turn{model:"m", content:X}, step.started c1, step.finished]` → `[…, assistant{text:"a", native:{model:"m", content:X}, toolCalls:[c1]}, tool c1]`;
    - a prior message with attachment `report.pdf` → its text ends `\n[attached: report.pdf]`;
    - **`streamRun`:** events 1–4 with 3 = `model.turn` → frames 1, 2 and 4 only.
  - **Run int** (fake gateway; poll RUN META for up to 20 s). Update step 4's event-order test for `routed`, `usage{route|name}` and `model.turn`.
    - **Auto, Sonnet:** `"go tools:0 words:5"` with the default pick → `routed{model:"claude-sonnet-5-5", by:"auto"}`; usage jobs `route`, `name` and `run`, with route and name on `claude-haiku-5-5`; the answer has `agent.pick:"auto"` and `agent.model:"claude-sonnet-5-5"`.
    - **Auto, Haiku:** `"route:haiku hi tools:0"` → `routed` Haiku.
    - **Auto never escalates:** `"route:opus hi tools:0"` → `routed` Sonnet.
    - **A manual pick:** `opus` → `routed{by:"pick"}`, and no `job:"route"` usage.
    - **Native turns:** a `tools:2` run → 3 `model.turn` events, and the SSE frames carry none of them.
    - **Privacy gate (Review Focus 1):** a `deepseek-flash` thread with `"slow tools:2"`; during the first tool step, a member's steer carrying an attachment is stored and handed to `startOrSteer`. The run ends `failed` with `RUN_REFUSED`, and no `usage{job:"run"}` event has a seq greater than the steer event's.
    - **Mid-answer drop (Review Focus 2):** `"drop:5 words:20"` → `failed` with the dropped-connection copy; the stored answer contains `Fake answer for` exactly once.
    - **Cut off:** `"cutoff"` → no `step.started`; the run ends `done`, and the answer ends with the `LENGTH_NOTE` text.
    - **Refused:** `"refuse"` → `failed` with the refusal copy.
    - **Budget:** pre-filled to the cap with `pick:"auto"` → `capped` and **no** usage events at all, router included.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.** The `routed` event and its `notifyRun` happen inside the route step, which is idempotent on retry (it skips when a `routed` event exists).
- [ ] **Step 4: Run** `npm test && npm run deploy:local && npm -w services run test:int`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(runs): runs route their model, refuse private content for DeepSeek before every call, replay native turns and end cleanly on cut-off, refusal or a dropped stream`.

### Task 7: The model pill, footers and room default in the UI [web chain; after Task 2, parallel with Tasks 3–6]

**Files:**
- Create: `web/components/chat/ModelPill.tsx`, `web/components/chat/ModelPill.test.tsx`, `web/lib/client/useModelPick.ts`
- Modify:
  - `web/components/chat/Composer.tsx`: `pill?: ReactNode` slot, left of Send;
  - `web/components/chat/ChatView.tsx`, `web/components/threads/ThreadView.tsx`, `NewThread.tsx`: send `model`;
  - `web/components/threads/RunBlock.tsx`: footers;
  - `web/components/shell/Header.tsx`: the private lock;
  - `web/components/threads/RunPanel.tsx`: a "Model" row;
  - `web/lib/server/forward.ts` (+ test).

**Behaviour (pinned, from `Fluid2.dc.html`):**
- **`useModelPick(chatId, roomDefault) → [pick, setPick]`:** per chat, held in memory. It follows the room default until the user picks, and resets on reload.
- **The pill:**
  - **Look:** the prototype's `k-btn` look, i.e. 30 px high, transparent border, background `#161B1D`, text `#C9D3D2` at 12.5 px, turning `#ECF1F0` on hover. The label is `pillLabel` with a chevron.
  - **Where:** every composer (threads, `/t/new`, people chats), because a people-chat `@agent` or `#tag` starts a run.
  - **While a run is live:** disabled (`aria-disabled`), with the hint "The running agent keeps its model."
- **The menu** (`role="menu"`, items `menuitemradio` + `aria-checked`):
  - **Placement:** opens upward, right-aligned to the pill; width `min(280px, 100vw − 32px)`, radius 12, background `#111416`, border `#22282B`.
  - **Items:** 36 px rows with the label (13 px), the mono price (11 px, tertiary), a check on the selected item, and a mono `default` tag on the room default.
  - **A private thread:**
    - a top line with a lock icon + "Private thread: DeepSeek is off" + a `?` hint "It has attachments. Private content never goes to DeepSeek.";
    - the DeepSeek rows at opacity .45 with `aria-disabled`.
  - **Admins** see a footer button "Make <label> the room default" when `canSetDefault`. It PUTs `/bff/api/rooms/<id>/model`; an error shows as a toast; success relies on `room.updated`.
  - **Keyboard:** ↑/↓ via `nextEnabled`; Enter selects and closes; Escape closes and returns focus to the pill; Tab closes.
  - **Motion:** opacity 0→1, y 6→0, scale .98→1, 180 ms ease-out; the check crossfades in 150 ms. Reduced motion: instant.
- **Footers:**
  - **A stored answer:** mono `footerText(agent, models)`.
  - **A live run:** once `routed` arrives, `<label> · <formatUsd(costMicros)>`, updating with each `usage`. Before that, `Auto`.
- **The header lock** (thread pages with `taint.length`): a 14 px stroke lock, tertiary, with the hint "Private: has attachments, so DeepSeek is off."
- **"This run" panel:** a Model row showing `modelLabel(models, view.model)`.
- **The BFF** allows `PUT /rooms/r/model`.

- [ ] **Step 1: Write failing tests:**
  - **`forward.test.ts`:** allows `PUT /rooms/r/model`.
  - **`ModelPill.test.tsx`** (Testing Library), with taint `["attachment"]` and value `"opus"`:
    - ↓ moves to Fable; ↓ again skips both DeepSeeks to Auto; Enter calls `onChange("auto")` and closes;
    - Escape closes and focuses the pill;
    - a member sees no "Make … the room default".
- [ ] **Step 2: Run** `npm -w web test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm -w web test && npm run check`. Once Task 6 is merged, check by hand with `npm run dev`:
  - pick Haiku → the footer reads `Haiku 5.5 · …`;
  - Auto + `route:haiku` → `Auto → Haiku 5.5`;
  - upload a file in a thread → the lock appears and the DeepSeek rows dim.
  - Expected: PASS, and the hand check behaves as pinned.
- [ ] **Step 5: Commit** `feat(web): model pill with room default, private-thread lock, model and cost on every answer`.

### Task 8: The load test: 25 concurrent runs + 100 WebSocket clients [wave 5, after Task 6]

**Files:**
- Create: `services/src/runs/runs.load.test.ts`, `services/vitest.load.config.ts` (the int env, `testTimeout` 600 s)
- Modify: `services/package.json` (`"test:load"`), `knip.json` (`src/**/*.load.test.ts`)

**Interfaces:**
- Consumes: step 3's tickets (`issueTicket`), the `connect` shape of `live.int.test.ts`, `roomsRepo` and the socket `send` action.
- **Setup:**
  - 10 users, all members of one fresh room;
  - 10 sockets each (100 in all), opened at most 10 at a time;
  - 5 of the users send 5 messages each over the socket at once, in #general: `"@agent load-<u>-<k> tools:2 words:40"` (25 under the 30-per-minute limit per user).

- [ ] **Step 1: Write the test.** Within **300 s**:
  - **Runs:** all 25 threads reach `done`; each thread has exactly one answer; each run's event seqs are gapless from 1.
  - **Fan-out:** every one of the 100 sockets received a `run.updated` with `status:"done"` for each of the 25 threads.
  - **Budget:** the room's `USAGE#<month>` `costMicros` equals the sum of the 25 runs' `costMicros` (route + name + turns).
  - **Cleanliness:** no socket received an `error` frame.
  - **Report:** p50 and p95 send→done times; the p95 fan-out lag (a done event's `at` → its socket arrival).
- [ ] **Step 2: Run** `npm run deploy:local && npm -w services run test:load`.
  - Expected: PASS, printing the timings.
  - If Floci can't hold 25 durable executions at once, record the ceiling and the symptom in `floci-compat.md`, then pass at the highest stable number, with Aman's numbers noted for the AWS run in step 11.
- [ ] **Step 3: Commit** `test(load): 25 concurrent agent runs and 100 sockets on Floci with exact metering`.

### Task 9: End-to-end smoke, one live run on Floci, and the learn doc [wave 6, after everything]

**Files:**
- Modify: `scripts/src/smoke.ts` (+ helpers), `docs/learn/README.md` (a study-list row), `docs/learn/floci-compat.md`
- Create: `docs/learn/05-model-gateway.md`

**Smoke checks to add** (fake gateway, real UI, owner A and guest B; one `check()` each):
1. **Pill:** a thread shows `Auto`. With the keyboard, A picks Haiku and sends `tools:0 hi` → the footer reads `Haiku 5.5 · $… · m:ss`.
2. **Auto:** `@agent hello tools:0 words:5` → the card's thread footer reads `Auto → Sonnet 5.5`; `route:haiku …` → `Auto → Haiku 5.5`.
3. **Room default:** A makes Opus the default → B's pill shows `Opus 5.5` after `room.updated`. B's menu has no "Make … the room default". A sets it back to Auto.
4. **Private:**
   - A uploads a file into a thread → the lock shows for B, and the DeepSeek rows are disabled;
   - a socket send with `model:"deepseek-flash"` → the toast shows `PICK_REFUSED`.
5. **Phone:** at 390×844, the pill shows `DS Flash` when picked, the open menu fits the viewport, and there's no horizontal scroll.
6. **Motion:** the menu opening shows ≥ 3 frames in motion; under reduced motion, 0.

**Live run on Floci** (real keys; by hand, once; counts toward the $3):
- `npm run deploy:local -- --live-models`, then `npm run dev`;
- in one thread, a Haiku run `"say hi in five words"` and a DeepSeek Flash run `"one fun fact about otters"`. Each footer shows the right label and a cost > $0.00;
- an Auto run `"write a haiku about rain"` shows `Auto → …`;
- then `npm run deploy:local` (back to fake).

Record the spend (the footers' total) in the ledger, and record Lambda egress to the providers in `floci-compat.md`.

**Learn doc `05-model-gateway.md`** (same shape as 04):
- **What was built and how to try it:** `--live-models`, `REAL_MODELS=1`, the fake's new directives (`route:`, `drop:`, `cutoff`, `refuse`), and the measured load-test numbers.
- **The patterns**, each an interview-ready paragraph:
  - a provider-agnostic gateway with a pricing meter in one place;
  - routing with a cheap classifier and a safe default;
  - data-classification taint and its enforcement point (where the data is about to leave, not where it was marked);
  - replaying native turns (thinking signatures, DeepSeek's reasoning) and why tool rounds need it;
  - prompt caching as a prefix match, and the run as an append-only prefix;
  - retry only what wrote nothing (idempotency at the stream boundary);
  - secrets from Secrets Manager with a per-container cache;
  - load testing a fan-out system.
- **The rulings** and the Floci notes.
- **"How big companies do it":**
  - OpenRouter and LiteLLM gateways;
  - ChatGPT's auto router and Cursor's Auto;
  - Claude.ai's model picker;
  - enterprise data-loss-prevention tags (Microsoft Purview labels);
  - Stripe-style usage metering;
  - how Anthropic and DeepSeek bill cache tokens.

- [ ] **Step 1: Add the smoke checks;** run `WEB_URL=http://localhost:3100 npm run smoke`. Expected: new checks fail first wherever behaviour is missing; fix, then **all** pass.
- [ ] **Step 2: Do the live run** as listed. Expected: both footers are correct, and the ledger total is ≤ $3.
- [ ] **Step 3: Write the learn doc** and the study-list row.
- [ ] **Step 4: Run everything:** `npm test`, `npm run check`, `npm -w services run test:int`, `npm -w services run test:load`, `npm run smoke`. Expected: all green.
- [ ] **Step 5: Commit** `test: model picker end-to-end; docs: step 5 learn doc`.

## Execution order and parallelism
| Wave | Tasks | Why it's safe |
|---|---|---|
| 1 | **1 ∥ 2**, separate worktrees | Disjoint: `services/src/models/{catalog,picks,privacy}.ts` vs `web/lib/**` |
| 2 | **3** ∥ **7** (web chain starts) | Task 3 touches only `services/src/models/{gateway,fake,index}.ts` (+ a one-line `steps.ts` compile fix); Task 7 only `web/` |
| 3 | **4 ∥ 5** (∥ 7 still) | Task 4: `models/{anthropic,keys,index}.ts`, the vitest configs, `package.json`s, `infra/lib/{config,runs}.ts`, `deploy-local.ts`. Task 5: `threads/`, `runs/{start,repo}.ts`, `chat/actions.ts`, `rooms/`, `infra/lib/rooms.ts`. Neither touches the other's files; they take turns on Floci |
| 4 | **6** | It needs Tasks 3 and 5; its files (`runs/{steps,loop,context,stream}.ts`) are disjoint from Task 4's, so it may start while Task 4 finishes |
| 5 | **8** | Needs Task 6 |
| 6 | **9** | Needs everything, including Task 7's merge |

Task 7's hand check waits for Task 6's merge.

## Rulings made while planning
| Ruling | Cost if wrong |
|---|---|
| **One Anthropic SDK client class serves both providers.** DeepSeek goes through its Anthropic-compatible endpoint, `<base>/anthropic`, which DeepSeek documents: streaming, tools, thinking, `stop_sequences`. The adapter patches its gaps: `is_error` is ignored (so errors are prefixed), `cache_control` is ignored, and `effort` takes only low/high/max (so it's left unset) | If DeepSeek's endpoint lags their OpenAI-format API, a second adapter (~150 lines) implements `ModelProvider`, and nothing else changes |
| **Auto picks only Haiku or Sonnet.** Haiku 5.5 ($0.10/$0.50) is cheaper than DeepSeek Flash at peak ($0.30/$1.20), and the step-5 decision frames Auto as Haiku vs Sonnet. DeepSeek is a manual pick or a room default | DeepSeek sees little traffic; letting Auto use it would be one more router word plus the privacy gate it already has |
| **Small jobs (router, naming) always run on Haiku, never DeepSeek** | Slightly dearer than DeepSeek off-peak; never private-text risk |
| **The native turn is stored per model call as a `model.turn` event and replayed verbatim to the same model**, because Claude's thinking signatures and DeepSeek's `reasoning_content` must come back during a tool round. It's never streamed to browsers | Larger event items (signatures; DeepSeek reasoning text) stay far under 400 KB. A mid-run model switch would rebuild from text, which never happens because a run keeps its model |
| **The privacy gate runs before every model call and reads the context's own messages**, not only the stored flag. A private steer into a DeepSeek run ends the run, rather than switching models | The user resends with another model. Switching mid-run would need a rebuild of the turns for the new provider |
| **A room default of DeepSeek on a private thread becomes Auto; a manual DeepSeek pick there is refused** | An admin who wanted "never Claude" gets Claude on private threads, which the privacy rule prefers |
| **Attachments taint the whole thread for good** (a string set, ADD-only) | A thread with one stray file loses DeepSeek; the user starts a new thread |
| **A model step retries only while it has written nothing.** A failure after text ends the run `failed` with the partial text | A transient blip mid-answer costs a resend instead of a silent retry, but never a doubled answer |
| **No server-side refusal fallback.** This deliberately departs from the claude-api skill's default of `fallbacks: "default"`: it needs the beta namespace, pricing by the served model and trimming the echoed content before the fallback block. **Flag this to Aman.** | A declined Sonnet, Opus or Fable answer ends the run with "Try another model." Adding it later is the beta call + those two rules |
| **`max_tokens` is 16,000 per run call**, which bounds a single call's overshoot of the cap (Fable's worst output is $0.64); 1,024 for router and naming. Effort is `medium` for runs and `low` for small jobs; DeepSeek gets its server default | Long answers end with the length note, and the user asks to continue |
| **DeepSeek is always billed at peak rates** (the off-peak windows and Chinese holidays aren't modelled) | DeepSeek costs show up to 2× high off-peak; the budget guard stays safe |
| **A stopped stream bills input from `message_start` + output as `ceil(chars/4)`.** Hidden thinking tokens aren't counted | A stopped long-thinking call is under-billed a little |
| **Fable 5.2's price comes from the live pricing page** (not in the skill), and its request rules are assumed to match Fable 5.1's. Sonnet 5.5's cache read uses the live $0.10, not the skill's cached $0.20 | Caught by the real-key suite (shape) and a pricing re-check (⚑) before the smoke |
| **Real models get no tools in this step**; the fake tools reach only the fake | Real runs are plain chat until the first real tools land; the adapter's tool path is proven by the live suite |
| **Keys come from one Secrets Manager secret on Floci and AWS.** `--live-models` copies them from `.env`; the default local deploy is fake | If Floci lacks Secrets Manager, the fallback is runtime env via `UpdateFunctionConfiguration` (still never in the template) |
| **Picks are stored as stable keys (`sonnet`); runs store the resolved id (`claude-sonnet-5-5`)** | Moving `sonnet` to a newer model is one catalog line; old answers keep their true model |
| **The router reads only the run's first message (≤ 4,000 chars), replying in one plain word rather than structured output** | A follow-up's complexity isn't re-judged: steers keep the run's model |
| **Steers keep the run's model**, and the pill is disabled while a run is live | To change model mid-task, stop and resend |
| **Thinking display stays `omitted`**, so progress notes between tool calls aren't shown | Runs look quieter between steps; `display:"updates"` (beta) can come later |
| **Prompt caching is top-level automatic on Claude run calls only** | First-call write premium (1.25×) on runs that never make a second call |
| **The per-chat pick lives in memory** | It resets on reload to the room default |
| **`run.started.model` is renamed `pick`; the resolved model arrives in `routed`** | Any step-4 reader of `run.started.model` must move (the web reducer, run int tests), and Tasks 2, 5 and 6 do |

## Self-review (done while writing)
1. **Spec coverage:**
   - **Picker** (all seven + Fake locally), room default by admins, per-message override → Tasks 1, 5, 7.
   - **Auto** (Haiku router, never Opus/Fable, leans Sonnet) → Tasks 1 and 6.
   - **DeepSeek with the taint rule:**
     - attachments as the source;
     - refusal by Auto, default or manual pick;
     - router on Haiku;
     - small jobs never on private text → Tasks 1, 5 and 6.
   - **Memory privacy:** memory doesn't exist yet. `privateOk` on the catalog and `runRefusal` are what memory filtering will use, so it isn't left as a gap.
   - **Cost shown on every answer** → Tasks 2 and 7.
   - **Per-call metering at real prices** → Tasks 1, 3 and 4.
   - **Budget checked before every call, router included** → Task 6.
   - **Keys:** Secrets Manager + `.env`, never in git → Task 4.
   - **Fake model selectable locally; Floci never calls a real model unless keys are set** → Tasks 3 and 4.
   - **Load test** → Task 8.
   - **Real-key testing, smoke-sized, ≤ $3** → Global Constraints, Tasks 4 and 9.
   - **Learn doc** → Task 9.
2. **Step scan:** every code step names its file, signature and pinned values. Bodies are spelled out only for `toMessages` and the gate/retry rules in `modelTurn`, which the types don't determine.
3. **Type consistency:**
   - pinned once in the shared contract: `ModelPick`, `TaintSource`, `TokenUsage`, `ProviderChunk`/`ModelChunk`, `servedBy`, `routed`, `model.turn`, `usage.job`, `Run.pick`/`pickBy`/`model`, `ThreadSummary.taint`, `RoomView.defaultModel`/`models`;
   - `parsePick`/`resolvePick`/`pickRefusal`/`runRefusal` are used with the same parameters in Tasks 1, 5 and 6.
4. **Review Focus:** each of the five is pinned in its owning task:
   - 1 in Tasks 1, 5 and 6;
   - 2 in Tasks 3 and 6;
   - 3 in Tasks 4, 6 and 9;
   - 4 in Tasks 1, 4 and 8;
   - 5 in Tasks 1 and 6.
5. **Proportion:** 62 KB against step 4's 57 KB, for 9 tasks. The extra size is the price table, the provider quirks and the privacy copy, all values the implementer can't derive. The only code block is the shared contract.
