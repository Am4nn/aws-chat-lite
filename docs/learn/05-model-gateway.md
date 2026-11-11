# Step 5: Model gateway (real models)

## What we built
- **A model pill in every composer.** Auto · Sonnet 5.5 · Haiku 5.5 · Opus 5.5 · Fable 5.2 · DeepSeek Flash · DeepSeek Pro (plus Fake locally), each with its price. It's a keyboard menu (↑/↓, Enter, Escape), it shows the short label on a phone, and it's locked while a run is live, because a run keeps the model it started with.
- **A room default.** Owners and admins make the picked model the room's default from the menu; everyone's pill follows at once. A pick in a chat lasts until reload.
- **Auto.** One cheap Haiku call reads the run's first message and answers `haiku` or anything else. `haiku` means Haiku; anything else, an error or a refusal means Sonnet. Auto never picks Opus, Fable or DeepSeek.
- **Private threads.** A message with an attachment makes its thread private for good (a lock in the header). DeepSeek never sees private content: a manual DeepSeek pick with a file is refused before anything is stored, a DeepSeek room default turns into Auto there, and a file steered into a running DeepSeek run ends it before its next call.
- **Cost on every answer.** The footer reads `Auto → Haiku 5.5 · $0.01 · 0:04`, metered at that model's real rates (cache reads and writes, Haiku's long-prompt card, DeepSeek at peak). While a run works the footer shows the model and the cost so far; the run panel has a Model row.
- **One gateway, three providers.** `fake`, `anthropic` and `deepseek`, the last two through one adapter on `@anthropic-ai/sdk` 1.8.0 (DeepSeek's Anthropic-compatible endpoint). Keys live in one Secrets Manager secret, never in a template, an environment variable or git.
- **A load test.** 25 agent runs at once, watched by 100 sockets, with exact metering. On Floci all 25 finished in 60 s, with the room's spend equal to the runs' costs to the micro-dollar.
- **`npm run smoke`** gained 7 model-picker checks (two browsers, an owner and a member).

## How to try it
```powershell
npm run deploy:local                       # the fake gateway: every model id is served by the fake, at that id's rates
npm run deploy:local -- --live-models      # real Claude, DeepSeek and Gemini: copies the 4 keys from .env into Floci's secret
npm run dev                                # then pick a model in any composer
REAL_MODELS=1 npm -w services run test:live  # the adapter against the real providers; stops itself at $0.50
npm -w services run test:load              # 25 runs + 100 sockets on Floci (fake gateway), prints its timings
```
`.env` (gitignored) holds `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `GEMINI_API_KEY` (for the image tool); `--live-models` stops before the deploy if any of the four is missing. A plain `deploy:local` goes back to the fake, so tests and the load test never spend money.

The fake model gained directives (still read from the thread's first message):

| Directive | Effect |
|---|---|
| `route:<word>` | the router's reply, so `route:haiku` makes Auto pick Haiku (and `route:opus` still gives Sonnet) |
| `drop:N` | the connection drops after N answer chunks (the headline is the first, so `drop:0` drops before any text), reporting usage first as a real provider does |
| `cutoff` | the turn stops at the length limit inside a tool call |
| `refuse` | the model declines, with no text |

## How a model call flows
```mermaid
sequenceDiagram
  participant R as run Lambda (durable)
  participant D as DynamoDB
  participant G as gateway()
  participant P as provider (fake / Claude / DeepSeek)
  R->>D: route step: Auto? one Haiku router call → routed {model}, thread.model
  loop each model step
    R->>D: limits, steers, then the privacy gate (thread taint + this call's own messages)
    R->>G: stream {model, system, messages (native turns verbatim), JOBS.run}
    G->>P: Messages API stream (keys from Secrets Manager, cached per container)
    P-->>G: text, tool_use, usage, end {stop, native}
    G-->>R: chunks; usage priced here (priceMicros)
    R->>D: text every 250 ms (turn N), model.turn {native}
    R->>D: one transaction: usage event + month spend + CALL# marker
  end
```

## The patterns
**A provider-agnostic gateway with the meter in one place.** The run loop asks `gateway().stream(request)` for a model id and gets back the same chunks whoever serves it: `text`, `tool_call`, `usage` and a final `end` with the stop reason and the provider's own content for the turn. `gateway()` picks the provider from the catalog, and it alone turns tokens into money (`priceMicros`, integer micro-dollars, rounded up). The provider reports tokens, never cost, so adding a provider can't get billing wrong, and the fake is billed at the rates of the model id it stands in for, so a local run costs what a real one would.

**Routing with a cheap classifier and a safe default.** Auto spends one Haiku call (1,024 tokens, low effort, the first 4,000 characters of the first message) to choose between a cheap model and a strong one. The router's whole vocabulary is one word: exactly `haiku` means Haiku, and *everything else* (a sentence, `opus`, an empty reply, an error, a refusal, a spent budget) means Sonnet. Failure leans to the model that can do the job, never the expensive tail, so a confused or attacked router can't escalate to Opus or Fable. A manual pick makes no router call at all.

**Data-classification taint, enforced where data leaves.** A file makes its thread private: an ADD-only string set (`taint`) on the thread, so a thread that went private stays private. The rule lives at the point where content is about to leave the system, before every model call, not where the file arrived. The gate reads the stored taint *and* the taint of the very messages this call will send, because the taint is written after the send is acknowledged: a steer with a file can land mid-run before its taint is stored, and a check of the flag alone would let it through. Upstream checks (refusing a DeepSeek pick at send, turning a DeepSeek default into Auto) are courtesy; the gate is the guarantee.

**Replaying native turns.** During a tool round a model must get its own previous turn back exactly: Claude's thinking blocks with their signatures, DeepSeek's reasoning, the `tool_use` blocks. So each finished call appends a `model.turn` event with the provider's content, verbatim, and the next call's context puts it back in place of the rebuilt text. These events stay in the log (they're how a retried run rebuilds its context) but the stream never sends them to browsers. A run keeps one model, so a turn is only ever replayed to the model that wrote it.

**Prompt caching as a prefix match.** Claude caches a prompt by its prefix. A run's context is append-only (system, the thread, then each turn and tool result in order), so every call's prompt starts with the previous call's, and top-level automatic caching (`cache_control: ephemeral`) turns the shared prefix into cache reads ($0.10 per million on Sonnet 5.5 against $2.00 for fresh input). The first call pays the 1.25× cache-write premium; a run with a tool round makes it back on its next call.

**Retry only what wrote nothing (idempotency at the stream boundary).** A durable step that fails is run again, and a model step streams text members are already reading. So: a call that drops before any text is simply retried; a call that drops *after* text ends the run failed with that text, once, rather than answering twice; and a step that fails for any other reason after writing (the log or the meter) retries with `text.reset`, which voids that turn's text and native turn in the log, the context and the browser. Every call is metered once: its usage event, the month's spend and a marker holding the step's result commit together, and a retried step returns the marker's result instead of calling again. An attempt that is about to be retried is still billed (the provider charged it), and a run's cost is the sum of its usage events, so the room's spend and the runs' totals always agree.

**Secrets from Secrets Manager with a per-container cache.** The keys are one JSON secret (`cl-<stage>-model-keys`). A Lambda reads it on its first real model call and keeps the promise for the container's life, so a warm run pays nothing and a key never sits in the function's configuration, the CloudFormation template or a log line (even the JSON parse error is replaced, because Node's message quotes the text). A failed read isn't cached, so the next call tries again. On AWS the secret is set by hand and retained; on Floci `--live-models` copies it from `.env` after the deploy. Until it is set on AWS the secret holds the random string CloudFormation generated, which isn't JSON, so every real run fails with "The agent hit an error." Put the keys JSON in right after the first deploy. Each Lambda container builds one gateway and keeps it, so the SDK clients reuse their connections from call to call.

**Load testing a fan-out system.** The load test drives the real stack: 10 users, 100 sockets (opened 10 at a time), 25 `@agent` messages sent at once, each a run with 2 tool steps (5 model calls, counting the router and the naming call). It checks what breaks under concurrency rather than speed alone: every run reaches done with exactly one answer and a gapless event log, every socket hears every run finish, no socket gets an error, and the room's month spend equals the sum of the runs' costs to the micro-dollar (the transaction that records a call is what makes that exact). That match alone can't see a call charged twice, because both totals come from the same usage events, so each run must also have exactly one usage event per call its message asks for (router, name, three turns). The test deletes its room, threads, runs and users afterwards, since Floci slows down as its store fills. It reports send→done latency and fan-out lag (a run's end to its arrival on each socket). Measured on Floci (one laptop, the fake model):

| Measure | First run | Again, later (a fuller store) |
|---|---|---|
| All 25 runs done | 59.6 s | 109.5 s |
| send → done, p50 / p95 | 51.4 s / 57.3 s | 90.6 s / 106.8 s |
| fan-out lag (run end → each of 100 sockets), p95 | 2.5 s | 2.0 s |

Floci held 25 durable executions at once. Most of a run's time there is DynamoDB writes, which Floci applies one at a time (see the Floci notes), so these numbers measure the emulator's write queue more than the design (the second run, on a store grown by the int suite, took nearly twice as long); the AWS run will give the real ones.

## Rulings
| Ruling | Cost if wrong |
|---|---|
| One SDK client class serves Claude and DeepSeek (DeepSeek's `/anthropic` endpoint); the adapter skips what DeepSeek ignores (effort, cache_control) | A second adapter (~150 lines) behind the same interface |
| Auto picks only Haiku or Sonnet; small jobs (router, naming) always run on Haiku | DeepSeek sees little traffic |
| No server-side refusal fallback: a declined answer ends the run "Try another model." | A manual retry |
| A model step retries only while it has written nothing; a drop after text ends the run failed | A blip mid-answer costs a resend, never a doubled answer |
| `text.reset` voids a failed attempt's native turn as well as its text | none |
| An attempt about to be retried is billed without a marker; a run's cost is the sum of its usage events | none |
| A failed naming call keeps the numbered name, and the run goes on | A thread stays `thread-N` after a blip |
| A room default of DeepSeek on a private thread, or with a file, becomes Auto (the pill shows Auto); a manual DeepSeek pick there is refused | An admin's "never Claude" default gets Claude on private threads |
| Attachments taint a thread for good | One stray file loses DeepSeek for that thread |
| `max_tokens` 16,000 per run call, 1,024 for router and naming; effort medium for runs, low for small jobs | Long answers end with the length note |
| DeepSeek is always billed at peak; a stopped stream bills its input plus ⌈chars/4⌉ output | Up to 2× high off-peak; a little under for hidden thinking |
| Real models get no tools yet; the fake tools reach only the fake | Real runs are plain chat for now |
| Picks are stable keys (`sonnet`); runs store the resolved id | Moving `sonnet` to a newer model is one catalog line |
| A pick lives in memory per chat, and the pill is locked while a run is live. Until a chat picks, a send names no model and the server applies the room default | It resets on reload; to switch mid-task, stop and resend |

## Floci notes
- **Lambdas reach the providers.** A live run on Floci (`deploy:local -- --live-models`) worked end to end: the run Lambda read its keys with `GetSecretValue` and streamed from `api.anthropic.com` and DeepSeek's `/anthropic` endpoint, so Floci's Lambda containers have outbound internet. Three real runs (Haiku, DeepSeek Flash, Auto → Haiku) cost $0.00023 in all.
- **25 durable executions at once** ran fine; the load test's latency is mostly Floci applying DynamoDB writes one at a time.
- **The secret keeps the last value put.** A plain `deploy:local` switches the gateway back to the fake but leaves the keys in Floci's secret, so put `{}` into `cl-local-model-keys` after a live session.

## Known limits
- Real models get no tools yet, so a real run is plain chat; the tool path is proven by the real-key suite, not by runs.
- A stream that stops early bills its output as ⌈characters/4⌉ of the text it showed; hidden thinking and half-sent tool input aren't counted.
- DeepSeek is billed at its peak rate around the clock, so off-peak costs read up to twice what DeepSeek charges.
- A declined answer isn't retried on another model; the member picks one and sends again.
- Fable 5.2's request rules are assumed to match Fable 5.1's; it wasn't part of the live run. Its price ($8 / $40, cache $0.20 / $10) was re-checked against Anthropic's model docs, as were the other Claude cards, and a test pins each one.

## How big companies do it
- **OpenRouter and LiteLLM:** gateways that put hundreds of models behind one API. OpenRouter normalises requests to the OpenAI chat format, routes by price, latency or uptime, falls back across providers, and returns the cost of each call in the response; LiteLLM is the self-hosted version, a proxy with per-key budgets and a price table, which is our `catalog.ts` + `priceMicros` + room budget.
- **ChatGPT's auto router and Cursor's Auto:** ChatGPT routes each conversation between a fast model and a thinking model with a trained router reading the request; Cursor's Auto picks a model for you and says which one answered. Both show the same contract as ours: the user can always override, and the answer names its model.
- **Claude.ai's model picker:** a pill by the input with the model's name; the choice sticks to the conversation, and a conversation keeps its model, which is why our pill locks while a run is live.
- **Data-loss-prevention labels (Microsoft Purview):** a document gets a sensitivity label that travels with it, and policies enforce it where the data leaves (an email to an outside domain, an upload to an unapproved app), not where the label was set. Our taint is a one-label version, enforced before every model call.
- **Stripe-style usage metering:** a meter event per call (amount, customer, time) aggregated per period, with the bill computed by the platform from its own price table, never trusted from the client. Our usage events are the meter events, and the month item is the aggregate.
- **How Anthropic and DeepSeek bill cache tokens:** Anthropic charges a 5-minute cache write at 1.25× the input rate and a cache read at a small fraction of it, and reports `cache_creation_input_tokens` and `cache_read_input_tokens` beside `input_tokens`, so all three are priced separately (as `priceMicros` does). DeepSeek caches prompt prefixes on its own, with no request setting, and bills a cache hit far below a miss ($0.006 against $0.30 per million on DeepSeek Flash at peak). Our Haiku card counts cache tokens toward its 100,000-token threshold, since they are part of the prompt.

## Interview angle
- "How do you add a second LLM provider without touching your agent loop?" A gateway with one chunk contract and the price table in one place; the provider only reports tokens.
- "How do you keep private data away from a third-party model?" Taint the data, keep the taint monotonic, and enforce it where the data is about to leave, checking the payload itself, not only a flag that may lag.
- "Your model call fails halfway through streaming. What happens?" Retry only if nothing was shown; otherwise end with what was shown. Any other failure voids that attempt's output before retrying, and the call is billed once either way.
- "How do you route between a cheap and an expensive model?" A cheap classifier with a one-word answer, a default that leans to the capable model, and a hard ceiling it can't escalate past.
- "How do you know your metering is right under load?" Commit each call's usage and its spend in one transaction, then check under concurrency that the period total equals the sum of the parts, and that the number of charges equals the number of calls you know were made.
