# Step 4: Agent Threads with a Fake Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Room members run `@agent` in numbered threads, backed by a deterministic, streaming fake model:
- **Threads:** `#N` threads with unique, renamable names that auto-archive after 7 idle days.
- **From a people chat:** `@agent …` starts a thread and posts one card that updates in place. A leading `#12` or `#name` delivers the message into that thread.
- **Runs:** a durable run loop with numbered run events, live status over the WebSocket, and the answer over resumable SSE.
- **Control:** steer by messaging mid-run; Stop (any member).
- **Budgets:** monthly per room, with the cap set by the owner and checked before every model call.
- **UI:** the G2 thread UI on desktop and phone.

**Architecture:**
- **A thread is a chat.** It's a `CHAT#<threadId>` partition with `kind: "thread"`, so step 3's send, history, search, sequence numbers and fan-out carry its messages. A thread item in the room partition holds its number, name and live status.
- **A run is one Lambda durable execution** (`DurableExecutionName = runId`). Each model call and each tool call is its own checkpointed `context.step`.
- **Run events:** the loop is the only writer of `RUN#<runId>` / `EV#<seq>` events, and it appends them in order.
- **Steering inbox = a cursor.** Steers are ordinary thread messages, and the loop reads the thread past its `seenSeq` between steps.
- **The close:** one transaction posts the answer and clears the active run, on the condition that the chat's `lastSeq` still equals `seenSeq`. A message that lands at the last moment makes the loop go round again instead of being lost.
- **The WebSocket** carries `run.updated` (a thread summary at step boundaries) to the room.
- **SSE:** the open thread reads `GET /runs/{id}/stream` with `Last-Event-ID`, authorized by a one-time stream ticket.
  - **AWS:** a `RESPONSE_STREAM` Function URL.
  - **Floci:** a local Node HTTP server that calls the same `streamRun`.
- **Models:** they sit behind a small `ModelGateway`. Step 4 ships only `fakeModel`.

**Tech Stack:** step 3's, plus `@aws/durable-execution-sdk-js` (already in services; proven in the spike) and `@aws-sdk/client-lambda` (services). No new web dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-chat-lite-design.md`. Read:
- "Product shape";
- "UI and motion";
- "Model gateway" (the fake model only);
- "Budgets and limits";
- "Architecture";
- "Floci first";
- "Decisions for steps 3–11";
- step 4 in "Proposed steps".

Also read `docs/learn/floci-compat.md` (durable works on Floci; response streaming doesn't) and the step 3 plan, whose interfaces this consumes: `broadcastToRoom`, `chatRepo().send/history`, `seqKey`, `Message`, `LiveSocket`, `backoffMs`, `MessageText`, `Composer`, `MessageRow`.

## Global Constraints

- **Steps 1–3 still apply:**
  - `cl-<stage>-` names, chat-lite's own Floci, no VPC/NAT/RDS;
  - the secret scan before commits and the commit trailer;
  - CLAUDE.md;
  - TDD;
  - step 3's socket protocol, which this step extends but never changes.
- **From the spec, verbatim:**
  - **Run caps:** **2 hours** (7,200,000 ms) and **200 steps** per run. There's no per-room concurrency limit.
  - **Budget:** **$3** per room per month by default. The **owner** sets each room's cap, and it resets on the **1st at 00:00 UTC**.
  - **Budget check:** it runs **before every model call**; at the cap the run stops with a clear message. Overshoot is bounded by the calls already in flight.
  - **Threads:** an atomic per-room counter gives `#1`, `#2`…; names are unique per room, and anyone can rename. Both `#12` and `#name` tag a thread.
  - **Archiving:** auto-archive after **7 days** idle (604,800 s). Archived threads are hidden from the sidebar but searchable and reopenable, and **never deleted**.
  - **Stop:** **any member** can stop a run.
  - **Cards:** one card per agent-started thread, updated in place, never many messages.
  - **Honest progress:** no percentage or progress bar for agent work. The allowed indicators are state, step count, elapsed time, the current step's name and cost. **Only money gets a bar.**
  - **Answer:** words fade or blur in (~400 ms each), batched per frame, never per token.
- **My calls (record them in the learn doc):**
  - **Money:** integer **micro-dollars** (`costMicros`) server-side; caps are **$0–$20**, rounded to cents.
  - **Fake pricing:** $3 in / $15 out per million tokens (3 / 15 micro-dollars per token); tokens = `ceil(chars/4)`.
  - **Run loop:**
    - text flushed to a run event every **250 ms**;
    - the stop flag polled every **1 s** while streaming and at every step boundary;
    - each durable step retries **2** times;
    - `executionTimeout` **130 min**, function timeout **15 min**;
    - a run whose `startedAt` is over **130 min** old is dead.
  - **SSE:**
    - polls events every **250 ms**;
    - a keepalive comment every **15 s**;
    - ends at **14 min** (the client resumes);
    - re-checks membership every **30 s**.
  - **Stream ticket:** TTL **60 s**, single use. The local stream server runs at `http://localhost:4600`.
  - **Model context:** the last **50** thread messages before the run.
  - **Names:**
    - 1–32 chars of `[a-z0-9-]` with at least one letter;
    - the provisional name is `thread-<N>`;
    - a suggestion that collides tries `-2`…`-9`, then keeps the provisional name.
  - **Cards and URLs:** the card summary is the answer's first line, ≤ **80** characters. Thread URLs are `/r/<roomId>/t/<number>`.
- **Motion** (Motion + `web/lib/motion.ts`; only transform/opacity, plus the height transitions named):

  | Moment | Motion |
  |---|---|
  | Sidebar selection | one shared `layoutId="nav-highlight"` across threads and chats, `spring.glide` |
  | Switch thread | `enterFrom(direction)` over the combined threads + chats order |
  | Step row appears | opacity 0→1, x −10→0, 400 ms ease-out |
  | Running step | name shimmer (1.8 s loop), spinner arc (0.8 s/turn), elapsed ticks each second |
  | Step finishes | check pops (`spring.pop`) + lime row flash `#1D2A12`→transparent, 500 ms |
  | Step output / run finishes | output: height + fade, 400 / 300 ms; live rows collapse into "▸ N steps", height 300 ms |
  | Answer | words: opacity 0→1, y 4→0, blur 4→0 px, 400 ms, new words batched per `requestAnimationFrame`; headline: y 18→0 + fade, 450 ms |
  | Steer bubble | springs in (y 10→0, scale .95→1, `spring.pop`) |
  | Card / capsule / budget | card: height + fade 300 ms, icon crossfade 150 ms; capsule: fades in 250 ms, border 400 ms; bar: width 500 ms |

  **Reduced motion:** everything is instant. The shimmer becomes static text, the spinner a static arc, and words appear without animation.
- **DynamoDB reserved words:** any attribute name that DynamoDB reserves (`status`, `name`, `number`, `text`, `ttl`, `type`, `data`, `count`, `size`, `user`, `role`, `key`, `value`, `comment`, `state`, `source`, `timestamp`, `session`, `token` and the rest of the list) must appear in Update/Condition/Filter/KeyCondition/Projection expressions only as `#placeholders`. Floci does not enforce this, but real AWS rejects it.
- **Shared contract:** defined once in `services/src/threads/types.ts` and mirrored in `web/lib/types.ts`.

### Protocol additions (pinned; every task uses these exact shapes)
```ts
type RunEndStatus = "done" | "stopped" | "failed" | "capped";
type ThreadStatus = "idle" | "running" | RunEndStatus;
type ThreadSummary = {
  roomId: string; threadId: string; number: number; name: string; status: ThreadStatus; rev: number; // +1 per write; clients keep the highest
  runId?: string; runFirstSeq?: number; startedAt?: string; endedAt?: string;  // active or last run
  steps: number; currentStep?: string; costMicros: number; summary?: string;
  createdBy: string; lastActivityAt: string; archived: boolean;               // archived is derived on read
};
type Budget = { spentMicros: number; capMicros: number; month: string /* "2026-11" */; resetsAt: string };
type RunEventBody =
  | { type: "run.started"; model: string; startedBy: string }
  | { type: "steer"; messageSeq: number; authorName: string; text: string }
  | { type: "text"; text: string }
  | { type: "step.started"; step: number; call: { id: string; name: string; input: Record<string, unknown> }; detail: string }
  | { type: "step.finished"; step: number; output: string; ms: number; ok: boolean }
  | { type: "usage"; model: string; inputTokens: number; outputTokens: number; costMicros: number }
  | { type: "run.finished"; status: RunEndStatus; reason?: string; ms: number; steps: number; costMicros: number };
type RunEvent = RunEventBody & { seq: number; at: string };
// Message gains: threadRef?: { threadId; kind: "started" | "delivered" }   (people-chat message → card / chip)
//                agent?: { runId; status: RunEndStatus; reason?; steps; costMicros; ms; model; firstSeq }  (answer, authorId "agent")
// RoomView gains: threads: ThreadSummary[]; budget: Budget
// client → server: send {…step 3 fields, threadId?}     stop {roomId, threadId}
// server → client: {type:"run.updated", roomId, thread, lastSeq, budget}   {type:"thread.updated", roomId, thread}
// SSE frame: "id: <seq>\nevent: run\ndata: <RunEvent JSON>\n\n"; keepalive ": ka\n\n"
```

### Table items added (single table `cl-<stage>-main`)
| Item | pk | sk | Notes |
|---|---|---|---|
| Room META (existing) | `ROOM#<roomId>` | `META` | + `threadSeq` (`ADD 1` allocates `#N`), + `budgetCapMicros` (absent = 3,000,000) |
| Thread | `ROOM#<roomId>` | `THREAD#<N, 10-digit pad>` | ThreadSummary fields minus `archived`, + `activeRunId`, `named` |
| Name guard (existing) | `ROOM#<roomId>` | `CHATNAME#<name>` | + `kind: "thread"`. Shared with chats, so a thread can't take a chat's name |
| Thread chat | `CHAT#<threadId>` | `META` | `{roomId, lastSeq, kind: "thread", number}` |
| Run | `RUN#<runId>` | `META` | `{roomId, threadId, number, status, model, startedBy, startedAt, endedAt?, firstSeq, seenSeq, steps, costMicros, stopRequestedBy?, answerSeq?}` |
| Run event | `RUN#<runId>` | `EV#<seq, 10-digit pad>` | `RunEvent`; never deleted |
| Usage | `ROOM#<roomId>` | `USAGE#<YYYY-MM>` | `{costMicros, calls}`, `ADD` per model call (UTC month) |
| Stream ticket | `STREAMTICKET#<t>` | `META` | `{userId, roomId, runId, expiresAt, ttl}`; consumed by a conditional delete |

### HTTP routes added (JWT; each also in the BFF allowlist)
- **`POST /rooms/{roomId}/threads {text, clientId}`** → 201 `{thread, message}`.
- **`PATCH /rooms/{roomId}/threads/{threadId} {name}`** → `{thread}`; 409 when the name is taken.
- **`PUT /rooms/{roomId}/budget {capUsd}`** → `{budget}`; owner only, 403 otherwise.
- **`POST /runs/{runId}/stream-ticket`** → `{url}`, where `url` = `${STREAM_URL}/runs/<runId>/stream?ticket=<t>`.

Thread history reuses `GET /rooms/{roomId}/chats/{threadId}/messages`. No route deletes a thread.

## Review Focus
1. **SSE resume must not duplicate or drop answer text.** After a mid-answer drop and a reconnect with `Last-Event-ID`, the shown answer equals the stored one exactly. Pinned in Task 7 (the stream sends only `seq > Last-Event-ID`), Task 3 (the reducer ignores `seq ≤ lastSeq`) and Task 10 (the smoke compares the text after a forced drop).
2. **A message sent as the run finishes is never lost.** The close transaction fails when `lastSeq` has moved past `seenSeq`, and the loop continues with a `steer`. Pinned in Task 5 (`closeRun` → `"unread"`, and the steer-at-the-end run test).
3. **No model call starts at or over the cap.** The run ends `capped` before any model call (no `usage` event), with the budget message. The month is the UTC month, even for an IST user at 03:00 on Dec 1. Pinned in Task 1 (`monthKey` boundaries) and Task 5 (int, pre-filled usage).
4. **A run that dies must not wedge its thread.** A failed invoke marks the run `failed`, and a throwing run ends `failed` and clears `activeRunId`. A run older than 130 min is dead, so the next message starts a new one. Pinned in Task 5 (the `fail` directive; a stale `startedAt`).
5. **A removed member keeps no access to runs.** Their `stop` acks an error, a stream-ticket request returns 404, and an open stream ends within 30 s. Pinned in Task 6 (socket int) and Task 7 (`streamRun` with a fake clock).

---

### Task 1: Thread, run and budget rules (pure, services) [wave 1, parallel]

**Files:**
- Create: `services/src/threads/types.ts` (the protocol types), `services/src/threads/model.ts`, `services/src/runs/model.ts`, `services/src/budget/model.ts`, with a `*.test.ts` beside each `model.ts`

**Interfaces:**
- Produces, in `threads/model.ts`:
  - `ARCHIVE_AFTER_SEC = 604_800`, `PROVISIONAL(n) = "thread-" + n`, `threadSk(n)`;
  - `threadName(raw: unknown): string`: trim, lowercase, `/^(?=.*[a-z])[a-z0-9-]{1,32}$/`, else `ValidationError("Thread names use a-z, 0-9 and dashes, 1 to 32 characters, with at least one letter.")`;
  - `uniqueCandidates(name): string[]`: `[name, name-2 … name-9]`, each ≤ 32 chars (it trims the base);
  - `isArchived(t: {status; lastActivityAt}, nowMs): boolean`: never while `running`;
  - `leadingTag(text): {number} | {name} | null`: only a tag at the very start, followed by whitespace or the end;
  - `summaryLine(text): string`: the first non-empty line, ≤ 80 characters + `…`.
- Produces, in `runs/model.ts`:
  - `RUN_MAX_MS = 7_200_000`, `RUN_MAX_STEPS = 200`, `DEAD_AFTER_MS = 7_800_000`, `eventSk(seq)`;
  - `endReason(s: {stopRequestedBy?; steps; startedAtMs; spentMicros; capMicros; month}, nowMs): {status: RunEndStatus; reason: string} | null`, with precedence stop > budget > steps > time.
- Produces, in `budget/model.ts`:
  - `DEFAULT_CAP_MICROS = 3_000_000`;
  - `monthKey(d: Date)` (UTC), `resetsAt(month)`;
  - `capFromUsd(raw: unknown): number`;
  - `budgetText(capMicros, month): string`.

- [ ] **Step 1: Write failing tests:**
  - **`threadName`:** `" PR-Check "` → `"pr-check"`; `"12"` and `"a".repeat(33)` throw.
  - **`uniqueCandidates`:** `uniqueCandidates("x")[8] === "x-9"`; for a 32-char base every candidate is ≤ 32 chars.
  - **`isArchived`:**
    - `{status:"done"}` idle 604,801 s → true; 604,799 s → false;
    - `running` idle 30 days → false.
  - **`leadingTag`:**
    - `"#12 also"` → `{number:12}`;
    - `"#pr-check also look at #43"` → `{name:"pr-check"}`;
    - `"look at #43"` → null;
    - `"#12abc"` → `{name:"12abc"}`.
  - **`summaryLine`:** `"\n\nShip it.\nmore"` → `"Ship it."`.
  - **`endReason`, one case each:**
    - `stopRequestedBy:"aman"` → `{status:"stopped", reason:"Stopped by aman."}`;
    - spent = cap = 3,000,000 → `{status:"capped", reason: budgetText(3_000_000,"2026-11")}`;
    - `steps:200` → `"Step limit reached (200 steps)."`;
    - elapsed 7,200,001 ms → `"Time limit reached (2 hours)."`;
    - otherwise → null.
  - **`monthKey`:**
    - `"2026-11-30T23:59:59Z"` → `"2026-11"`;
    - `"2026-12-01T00:00:00Z"` → `"2026-12"`;
    - `"2026-12-01T03:00:00+05:30"` → `"2026-11"`;
    - `resetsAt("2026-12") === "2027-01-01T00:00:00.000Z"`.
  - **`capFromUsd`:** `3` → 3,000,000; `2.555` → 2,560,000; `0` → 0; `20.01`, `-1` and `"3"` throw.
  - **`budgetText(3_000_000,"2026-11")`:** `"This room has used its $3.00 budget for November. It resets on December 1 (00:00 UTC)."`
- [ ] **Step 2: Run** `npm -w services test -- threads runs budget`. Expected: FAIL (missing modules).
- [ ] **Step 3: Implement.** Errors reuse `rooms/model.ts`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(threads): thread, run-limit and budget rules`.

### Task 2: Model gateway, fake model and fake tool (pure, services) [wave 1, parallel]

**Files:**
- Create: `services/src/models/gateway.ts`, `services/src/models/fake.ts`, `services/src/models/fake.test.ts`, `services/src/runs/tools.ts`, `services/src/runs/tools.test.ts`

**Interfaces:**
- Produces, in `gateway.ts`. Step 5 implements this for real, so keep it this small:
```ts
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ModelMessage =
  | { role: "user"; author: string; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; output: string };
export type ToolSpec = { name: string; description: string; inputSchema: object };
export type ModelRequest = { model: string; system: string; messages: ModelMessage[]; tools: ToolSpec[]; signal?: AbortSignal };
export type ModelChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number; costMicros: number };
export interface ModelGateway { stream(req: ModelRequest): AsyncIterable<ModelChunk> }
export const NAME_PROMPT = "Name this thread in 1 to 3 lowercase words joined by dashes. Reply with the name only.";
export function gateway(env = process.env): ModelGateway; // MODEL_GATEWAY=fake → fakeModel(); otherwise throws "Unknown model gateway"
```
- `fakeModel({ sleep }): ModelGateway`. It's deterministic, and reads its directives from the **first** user message:
  - **Directives:** `tools:N` (0–5, default 2), `words:N` (1–400, default 48), `slow` (150 ms per word instead of 15), `fail` (throws `"fake model failure"`).
  - **Tool turns:** with `k` tool results so far and `s` user messages after the first tool message, while `k < N + s` it yields one `tool_call` `{id:"call-<k+1>", name:"fake.lookup", input:{query:<first 6 words>, slow}}`.
  - **Answer:** otherwise it streams `Fake answer for "<first 6 words>".`, a blank line, then W body words taken cyclically from a fixed 24-word list and ending in ".", one `text` chunk per word (with its trailing space).
  - **Usage** comes last, always (on abort too): `in = ceil(input chars/4)`, `out = ceil(output chars/4)`, `costMicros = 3·in + 15·out`.
  - **Naming:** with `system === NAME_PROMPT`, it yields the first three `[a-z0-9]+` words of the lowercased text (`@mentions` removed), joined by `-`.
- `runTool(call, { sleep }): Promise<{output: string; ok: boolean}>`: `fake.lookup` sleeps 200 ms (1,500 ms when `input.slow`) and returns `Found 3 notes about "<query>".` followed by three `- note n: …` lines. Any other name → `{ok:false, output:"Unknown tool <name>."}`. Also exports `FAKE_TOOLS: ToolSpec[]`.

- [ ] **Step 1: Write failing tests** (`sleep` is a no-op):
  - **Determinism:** the same request twice → identical chunk lists.
  - **No tools:** `"hi tools:0 words:5"` → the text chunks join to headline + `\n\n` + 5 words; usage is last; no `tool_call`.
  - **`tools:2`:**
    - no results → exactly one `tool_call` `call-1`;
    - 2 results → text;
    - 2 results + a user message after the first tool message → a third `tool_call`.
  - **Usage:** 40 input chars and 20 output chars → `{inputTokens:10, outputTokens:5, costMicros:105}`.
  - **Abort:** after 3 text chunks → no more text, and the last chunk is usage.
  - **`fail`:** the iterator throws `"fake model failure"`.
  - **Naming:** `NAME_PROMPT` on `"@agent Check PR 41 and 42"` → `"check-pr-41"`.
  - **Gateway:** `gateway({MODEL_GATEWAY:"openai"})` throws.
  - **Tools:** `runTool(fake.lookup)` → `ok`, and the output starts `Found 3 notes about`. An unknown name → `ok:false`.
- [ ] **Step 2: Run** `npm -w services test -- models tools`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(models): model gateway interface and a deterministic streaming fake model`.

### Task 3: Web thread logic: types, run reducer, SSE reader, formatters (pure) [wave 1, parallel]

**Files:**
- Create: `web/lib/client/run.ts`, `sse.ts`, `runStream.ts`, `threads.ts`, `format.ts` (all in `web/lib/client/`, each with a `*.test.ts`)
- Modify: `web/lib/types.ts` (the protocol mirror; `LiveEvent` gains `run.updated` and `thread.updated`)

**Interfaces:**
- **`run.ts`:**
  - `RunItem = {kind:"step"; step; name; detail; status:"running"|"done"|"failed"; output?; ms?; startedAt} | {kind:"steer"; messageSeq; authorName; text; at}`;
  - `RunView = {lastSeq; status:"running"|RunEndStatus; reason?; items: RunItem[]; text; costMicros; model?; startedAt?; endedAt?}`;
  - `emptyRun()`;
  - `applyRunEvent(v, e): RunView`, which ignores `e.seq ≤ v.lastSeq`;
  - `queuedSteers(v, steers: Message[]): Message[]`: steers not yet read by the loop.
- **`sse.ts`:** `createSseParser(): { push(chunk: string): {id; event; data}[] }`. It handles frames split across chunks and `\r\n`, and ignores `:` comments.
- **`runStream.ts`:** `openRunStream({runId, getUrl: () => Promise<string>, onEvent, fetchImpl?, random?}): {close(); drop()}`:
  - Reads with `fetch`, sending `Last-Event-ID: <last seq>` after the first connect.
  - When the body ends without `run.finished`, or on an error, it reconnects after `backoffMs(attempt, random)` with a **fresh** URL.
  - Stops after `run.finished`. `drop()` aborts only the current request (for the smoke).
- **`threads.ts`:**
  - `applyThreadUpdate(list, t)`: upserts by `threadId`, keeping the higher `rev`;
  - `sidebarThreads(list, nowMs)`: not archived, newest `lastActivityAt` first;
  - `liveCount(list)`;
  - `threadMeta(t, nowMs, timeZone?) → {text; tone:"live"|"muted"}`;
  - `groupThread(messages, thread?) → Block[]`, where `Block = {kind:"message"; message} | {kind:"run"; trigger; steers: Message[]; answer?}`. A run starts at `answer.agent.firstSeq` (or `thread.runFirstSeq` for the live run), and the user messages between the trigger and the answer are its steers.
- **`format.ts`:**
  - `formatElapsed(ms)`: `m:ss`, or `h:mm:ss` from an hour;
  - `formatUsd(micros)`: 2 decimals, `"<$0.01"` for 1–9,999;
  - `budgetFill(b)`: 0–100, and 100 when the cap is 0;
  - `splitHeadline(text) → {headline|null; body}`: the first line when a blank line follows and it's ≤ 120 characters;
  - `streamWords(text, final)`: complete words only, unless `final`.

- [ ] **Step 1: Write failing tests:**
  - **Reducer:**
    - `step.started` then `step.finished` → one done step with its output and ms;
    - three `text` events concatenate;
    - the same event twice changes nothing; `seq ≤ lastSeq` is ignored;
    - `steer` lands after the steps before it;
    - `run.finished {status:"stopped", reason}` sets both;
    - `queuedSteers` returns a steer message with no `steer` event yet.
  - **SSE parser:** `'id: 1\nevent: run\ndata: {"a"'` + `':1}\n\n: ka\n\n'` → one frame `{id:"1", data:'{"a":1}'}`. `\r\n` parses the same.
  - **openRunStream** (a fake `fetch` returning `ReadableStream`s, fake timers):
    - a first body with seq 1–2 that ends → the second request has `last-event-id: 2`, and `getUrl` was called twice;
    - after `run.finished`, no further request;
    - `close()` mid-read → no reconnect.
  - **threads:**
    - a lower-`rev` update is ignored;
    - `sidebarThreads` hides archived threads and orders by `lastActivityAt`;
    - `threadMeta`:
      - running, `steps:3`, started 64 s ago → `{text:"step 3 · 1:04", tone:"live"}`;
      - done at `2026-11-11T14:05Z`, same day, `"UTC"` → `"14:05"`;
      - `capped` → `"budget"`;
      - `stopped` → `"stopped"`;
    - `groupThread([u1, u2, answer{firstSeq:1}])` → one run block with one steer.
  - **format:**
    - `formatElapsed(64_000) === "1:04"`, `formatElapsed(3_726_000) === "1:02:06"`;
    - `formatUsd`: `0` → `"$0.00"`, `1_500` → `"<$0.01"`, `42_000` → `"$0.04"`;
    - `budgetFill({spentMicros:1.5e6, capMicros:3e6}) === 50`; over the cap → 100;
    - `splitHeadline("Title\n\nbody")` → `{headline:"Title", body:"body"}`;
    - `streamWords("hello wor", false)` → `["hello"]`; with `true` → `["hello","wor"]`.
- [ ] **Step 2: Run** `npm -w web test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): run event reducer, resumable SSE reader, thread list and money formatting`.

### Task 4: Threads and budgets on Floci: counter, names, rename, tags, room view, cap

**Files:**
- Create: `services/src/threads/repo.ts`, `services/src/threads/handler.ts` (HTTP), `services/src/threads/handler.test.ts`, `services/src/threads/repo.int.test.ts`, `services/src/budget/repo.ts`, `infra/lib/threads.ts`, `infra/lib/threads.test.ts`
- Modify:
  - `services/src/rooms/access.ts` (+ test): `can("setBudget")` is owner only;
  - `services/src/rooms/repo.ts`: `getRoomView` returns `threads` (`archived` derived) and `budget`, both from the existing room query; `createChat` also refuses a thread's name;
  - `services/src/chat/search.ts`: also searches thread chats, archived ones included;
  - `infra/lib/core-stack.ts`: `addThreads(this)`.

**Interfaces:**
- Consumes: Task 1; step 3's `chatRepo().send` and `broadcastToRoom`.
- Produces `threadsRepo()`:
  - `createThread(user, roomId, {text, clientId, from?: {chatId; seq}}) → {thread; message}`:
    - `ADD threadSeq 1` on room META (`attribute_exists(pk)`);
    - one transaction: the thread item (provisional name, `named:false`, `idle`, `rev:1`), the `CHAT#<id> META {kind:"thread"}` and the name guard;
    - `chatRepo().send` of the first message;
    - a `thread.updated` broadcast.
  - `rename(user, roomId, threadId, raw) → ThreadSummary`: any member. One transaction:
    - delete the old guard (`chatId = :t`);
    - put the new guard (`attribute_not_exists`);
    - update the thread (`name = :old`, `named = true`, `ADD rev 1`).

    A failure → `Conflict("#<name> is taken.")`. It broadcasts `thread.updated`.
  - `nameIfProvisional(roomId, threadId, suggestion) → ThreadSummary | null`: tries `uniqueCandidates(threadName(suggestion))` while `named = false`.
  - `threadById(roomId, threadId)`, `threadByTag(roomId, tag) → ThreadSummary | null`, `summary(item, nowMs)`.
- Produces `budgetRepo()`:
  - `get(roomId, now) → Budget` (consistent);
  - `record(roomId, costMicros, now) → Budget` (`ADD costMicros, calls` on `USAGE#<monthKey>`);
  - `setCap(user, roomId, capUsd) → Budget`.
- `addThreads(stack)`: Lambda `cl-<stage>-threads` (table access + `allowBroadcast`) serving the three room routes. The stream-ticket route comes in Task 7.

- [ ] **Step 1: Write failing tests**
  - **Int:**
    - **Counter:** 5 concurrent `createThread`s → numbers 1–5, distinct and gapless, named `thread-1`…; the first message is in the thread's history.
    - **Rename:**
      - renaming to `pr-check` works;
      - a second thread renaming to `pr-check`, or to `general` (the chat) → Conflict;
      - `createChat("pr-check")` → Conflict.
    - **Suggested names:** `nameIfProvisional("pr-check")` on a third thread → `pr-check-2`; on a renamed thread → null.
    - **Tags:** `threadByTag({number:2})` and `{name:"pr-check"}` resolve; `{name:"general"}` → null.
    - **Room view:** `getRoomView` lists the threads, and one with `lastActivityAt` set back 8 days has `archived:true`.
    - **Search:** finds the first message's word in its thread.
    - **Budget:**
      - two `record`s → `spentMicros` is their sum under this month's key;
      - `setCap` by an admin → Forbidden; by the owner with 5 → `capMicros:5_000_000`.
    - **Membership:** a non-member's `createThread` → NotFound.
  - **Unit (fake repos):** `PUT /rooms/r/budget {capUsd:"x"}` → 400; `PATCH …/threads/t {name:"12"}` → 400.
  - **Infra:** the three routes have the JWT authorizer, and no route key starts with `DELETE /rooms/{roomId}/threads`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run deploy:local && npm -w services run test:int`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(threads): numbered threads with unique names, rename, tags, archive-by-idle and room budgets`.

### Task 5: The durable run engine

**Files:**
- Create: `services/src/runs/repo.ts`, `context.ts` (+ `context.test.ts`), `start.ts`, `loop.ts`, `notify.ts`, `repo.int.test.ts` and `run.int.test.ts` (all in `services/src/runs/`), `infra/lib/runs.ts`, `infra/lib/runs.test.ts`
- Modify:
  - `infra/lib/core-stack.ts`: `addFunction` takes `props?: Partial<NodejsFunctionProps>`; `addRuns(this)`; `allowRunStart(threadsFn)`;
  - `services/src/threads/handler.ts`: `POST /threads` calls `startOrSteer`;
  - `services/package.json`: `@aws-sdk/client-lambda`;
  - `docs/learn/floci-compat.md`: does a Lambda invoking a durable alias work on Floci?

**Interfaces:**
- Consumes: Tasks 1, 2 and 4; `broadcastToRoom`, `seqKey`.
- `runsRepo()`:
  - `getRun(runId)`;
  - `eventWriter(runId) → Promise<{append(b: RunEventBody): Promise<RunEvent>}>`: it starts after the newest stored `EV#` (descending, limit 1), puts with `attribute_not_exists(sk)`, and awaits each put in order;
  - `events(runId, afterSeq, limit = 100)` (consistent);
  - `unread(threadId, afterSeq) → Message[]`;
  - `prior(threadId, uptoSeq) → Message[]` (≤ 50);
  - `progress(run, {steps?, currentStep?, costMicros?}) → ThreadSummary`: RUN + THREAD, `ADD rev 1`;
  - `requestStop(user, roomId, threadId) → {runId}`: checks membership, then sets `stopRequestedBy = username` with `#status = :running`. No active run → `Conflict("Nothing is running.")`.
  - `closeRun(run, {status, reason?, text, seenSeq, force}) → "closed" | "unread" | "already"`: one `TransactWrite` of four items:
    1. `CHAT#<threadId> META`: `SET lastSeq = :seen + 1`, on the condition `lastSeq = :seen`;
    2. put the answer `Message` (`authorId/authorName "agent"`, `agent:{…, firstSeq}`) at `seqKey(seen+1)`;
    3. THREAD: `REMOVE activeRunId`; set status, `summary`, `endedAt` and `lastActivityAt`; `ADD rev 1`;
    4. RUN: set status, `answerSeq` and `endedAt`, on the condition `attribute_not_exists(answerSeq)`.

    Item 4 failing → `"already"`. Item 1 failing without `force` → `"unread"`. With `force`, it rereads `lastSeq` and retries.
- `buildContext(prior: Message[], events: RunEvent[]) → ModelMessage[]`:
  - **Prior messages:** `authorId === "agent"` → assistant; others → user (author = `authorName`).
  - **Then the run's events, in order:**
    - consecutive `text` events merge into one assistant text;
    - `step.started` adds its `call` to the current assistant message;
    - `step.finished` → a `tool` message;
    - `steer` → a user message.
- `startOrSteer(user, roomId, threadId, message) → {runId; started: boolean}`:
  1. Puts RUN META (`running`, `model:"fake"`, `firstSeq = seenSeq = message.seq`).
  2. Updates THREAD on the condition `attribute_not_exists(activeRunId) OR startedAt < :deadAt` (now − 130 min).
     - **Fails:** that's a steer. It sets only `lastActivityAt` and returns `{started:false}`.
     - **Succeeds:** it invokes `RUN_FN_NAME:RUN_FN_QUALIFIER` (`InvocationType:"Event"`, `DurableExecutionName: runId`, `{runId}`). If the invoke throws → `closeRun(force, "failed", "The run couldn't start.")`.
  3. Calls `notifyRun`.
- `notifyRun(roomId, thread, lastSeq)` broadcasts `run.updated` with `budgetRepo().get`.
- `loop.ts`: `handler = withDurableExecution(runLoop)`, where `runLoop({runId}, ctx)` runs:
  1. **`ctx.step("load")`.**
  2. **`ctx.step("name")`:** on the first run while `named:false`. Budget check → `gateway().stream` with `NAME_PROMPT` → `budget.record` → `nameIfProvisional` → a `thread.updated` broadcast.
  3. **For i = 1, 2, …, `ctx.step("model-"+i)`:**
     - `endReason` first; a hit ends the run;
     - unread messages → `steer` events, and `seenSeq` advances;
     - `buildContext` → stream, with `text` flushed every 250 ms and the stop flag polled every 1 s (an `AbortController`);
     - on `usage`: a `usage` event, `budget.record`, `progress({costMicros})`;
     - returns `{toolCalls, seenSeq, end?}`.
  4. **No tool calls:** `ctx.step("close-"+i)`; `"unread"` continues the loop.
  5. **Each tool call:** `ctx.step("tool-"+i+"-"+id)`:
     - checks the stop flag;
     - `step.started`, `progress({steps, currentStep})`, `notifyRun`;
     - `runTool`;
     - `step.finished`, `notifyRun`.
  6. **Errors** that outlive the step retries → `closeRun(force, "failed", "The agent hit an error.")`.

  `run.finished` is appended before every close, and `notifyRun` runs after it.
- `addRuns(stack)` → `{runFn, alias}`:
  - `cl-<stage>-run`: `durableConfig {executionTimeout: 130 min, retentionPeriod: 7 days}`, timeout 15 min, table access, `allowBroadcast`, alias `live`, env `MODEL_GATEWAY=fake`.
  - `stack.allowRunStart(fn)` grants `lambda:InvokeFunction` on the alias and sets `RUN_FN_NAME` and `RUN_FN_QUALIFIER`.

- [ ] **Step 1: Write failing tests**
  - **Unit (`buildContext`):**
    - prior `[user "hi"]` + `[step.started call-1, step.finished, text "a ", text "b"]` → `[user, assistant{toolCalls:[call-1]}, tool{call-1}, assistant "a b"]`;
    - a `steer` between steps → a user message in that position.
  - **Repo int:**
    - two `eventWriter`s, one after the other, write seq 1–3 then 4–5;
    - `closeRun`:
      - `seenSeq` 2 after `lastSeq` moved to 3 → `"unread"`, and `activeRunId` is kept;
      - equal → `"closed"`, with the answer at `seenSeq + 1`;
      - called again → `"already"`, with one answer in history;
    - `requestStop` on an idle thread → Conflict.
  - **Run int** (the deployed durable function; poll RUN META for up to 20 s):
    - **`"go tools:2 words:10"`** → `done`:
      - events go `run.started`, 2×(`step.started`, `step.finished`), `text`…, `usage`, `run.finished`;
      - seqs run 1..N with no gaps;
      - the answer has `agent.steps === 2`;
      - the thread is renamed from `thread-1` to `go-tools-2`;
      - the month usage rose by the run's `costMicros`.
    - **Steer:** `"slow tools:2"`, plus a thread message after the first `step.started` → a `steer` event, 3 steps, `done`.
    - **Steer at the end:** `"slow tools:0 words:60"`, plus a thread message after the first `text` (while the final turn streams). Expected:
      - the first close returns `"unread"`;
      - a `steer` event follows;
      - the run ends `done` with **one** answer containing the `Fake answer for` headline twice.
    - **Stop:** `"slow words:400"` + `requestStop` after the first `text` → `stopped` within 3 s, reason `"Stopped by <username>."`, with the partial text kept.
    - **Cap:** usage pre-filled to the cap → `capped`, no `usage` event, reason `budgetText(…)`.
    - **Fail:** `"fail"` → `failed`, and the thread has no `activeRunId`.
    - **Dead run:** `activeRunId` set with `startedAt` 131 min ago → `startOrSteer` returns `started:true`.
  - **Infra:** the run function has `DurableConfig.ExecutionTimeout` 7800 and an alias `live`; the threads Lambda may invoke the alias.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run deploy:local && npm -w services run test:int`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(runs): durable run loop with an event log, steering cursor, stop flag, caps and budget checks`.

### Task 6: People chat ↔ threads: `@agent` cards, tag delivery, thread sends, Stop

**Files:**
- Create: `services/src/threads/route.ts`, `services/src/threads/route.test.ts`
- Modify: `services/src/chat/actions.ts` (`send` goes through `routeSend`; a new `stop` action), `services/src/chat/model.ts` (`threadRef`, `agent`), `infra/lib/live.ts` (`ACTIONS` + `stop`; `allowRunStart(liveFn)`), `services/src/live/live.int.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5; `parseMentions`.
- **`mentionsAgent(text)`:** `parseMentions(text, [{userId:"agent", username:"agent"}])`.
- **`rewriteTags(text, resolve: (name) => number | null)`:** rewrites thread `#name` → `#<N>` outside code.
- **`routeSend(user, frame) → Message`**, in this order:
  1. rewrite the tags;
  2. `chatRepo().send`;
  3. **thread chat** → `startOrSteer`;
  4. **people chat with a `threadId`, or a `leadingTag` that resolves to a thread:**
     - send a copy into the thread (`clientId + ":t"`), then `startOrSteer`;
     - set `threadRef {kind:"delivered"}` on the original and broadcast `message.updated`;
  5. **people chat with `mentionsAgent`:**
     - `createThread(…, from)`, then `startOrSteer`;
     - set `threadRef {kind:"started"}` and broadcast `message.updated`.
- **`stop {roomId, threadId}`** → `requestStop`; ack `{runId}` or `ok:false` with the error.

- [ ] **Step 1: Write failing tests**
  - **Unit:**
    - `mentionsAgent("hey @agent check")` is true; inside backticks it's false; `a@agent.com` is false;
    - `rewriteTags("see #pr-check and #general", n => n === "pr-check" ? 4 : null) === "see #4 and #general"`.
  - **Socket int** (two users):
    - **Card:** A sends `"@agent look tools:1"` in #general. B gets `message.new`, then `message.updated` with `threadRef.kind === "started"`, then `run.updated` frames ending `status:"done"`. #general gained exactly 1 message.
    - **Delivery:** A sends `"#1 and this"` → thread 1 gets A's copy and a new run, and the original has `threadRef.kind === "delivered"`.
    - **Stop:** B (a member) stops A's `slow words:400` run → ack ok, then `run.updated` with `status:"stopped"`.
    - **Removed member:** after B's removal, B's `stop` acks `ok:false`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run deploy:local && npm -w services run test:int`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(threads): @agent starts a thread with an in-place card, #tags deliver into threads, any member can stop`.

### Task 7: Resumable SSE: stream tickets, `streamRun`, the Function URL and the local server

**Files:**
- Create: `services/src/runs/stream.ts`, `stream.test.ts`, `stream-handler.ts`, `stream-tickets.ts` (all in `services/src/runs/`), `infra/lib/stream.ts`, `infra/lib/stream.test.ts`, `scripts/src/stream-local.ts`, `scripts/src/dev.ts`
- Modify: `infra/lib/core-stack.ts` (`addStream(this)`, CfnOutput `StreamUrl`), `services/src/threads/handler.ts` (`POST /runs/{runId}/stream-ticket`), the root `package.json` (`"dev": "npm -w scripts run dev"`), `scripts/package.json` (`"dev": "tsx src/dev.ts"`), `docs/learn/floci-compat.md`

**Interfaces:**
- **`issueStreamTicket(user, runId) → {ticket}`:** a member of the run's room, else NotFound; 60 s.
- **`consumeStreamTicket(t, runId) → {userId, roomId} | null`:** a conditional delete; the ticket's `runId` must match.
- **`streamRun(req: {runId; ticket; lastEventId?}, sink: {status(code); write(s); end()}, deps = {repo, isMember, nowMs, sleep}) → Promise<void>`:**
  - **Bad ticket:** `status(401)` and `end`.
  - **Otherwise:** `status(200)`, then a loop:
    - send `events(runId, cursor)` as frames and advance the cursor;
    - after writing `run.finished` → end;
    - `: ka` every 15 s;
    - `isMember` checked every 30 s (false → end);
    - at 14 min → end;
    - else sleep 250 ms.
  - **`lastEventId`:** parsed as an integer ≥ 0 (default 0).
- **`stream-handler.ts`:** `awslambda.streamifyResponse` around `streamRun` (the same shape as `spike/sse.ts`):
  - `runId` from `rawPath` `/runs/<id>/stream`, the ticket from the query, `last-event-id` from the headers;
  - `content-type: text/event-stream`, `cache-control: no-cache`.
- **`addStream(stack)`:**
  - Lambda `cl-<stage>-stream`: read-only table access, timeout 15 min;
  - a Function URL with `authType NONE`, `RESPONSE_STREAM`, CORS `allowedOrigins ["*"]`, `allowedHeaders ["last-event-id"]` (the ticket is the auth and no cookies travel, so `*` is safe);
  - the threads Lambda's `STREAM_URL`: the Function URL on AWS, `http://localhost:4600` locally.
- **`startStreamServer(port = 4600): http.Server`:**
  - serves `GET /runs/:id/stream` through `streamRun` (Node `res` as the sink) and answers `OPTIONS` with the same CORS;
  - uses the Floci env from `localEnv` and `TABLE_NAME=cl-local-main`.

  `dev.ts` starts it, spawns `npm -w web run dev`, and stops both on exit.

- [ ] **Step 1: Write failing tests**
  - **Unit (fake repo, sleep and clock):**
    - events 1–5 (`run.finished` at 5) with `lastEventId "3"` → frames 4 and 5 only, then `end`;
    - a frame is exactly `id: 4\nevent: run\ndata: {…}\n\n`;
    - a running run idle for 15 s → one `: ka`;
    - `isMember` false at 31 s → `end` before 31.3 s of fake time;
    - at 14 min → `end` without `run.finished`;
    - a bad ticket → `status(401)`.
  - **Int:**
    - `issueStreamTicket` for a non-member → NotFound;
    - a ticket consumed for another `runId` → null; a second consume → null;
    - `startStreamServer(0)`: a finished run streams all frames and closes; `Last-Event-ID: 2` starts from 3.
  - **Infra:** the Function URL has `InvokeMode: RESPONSE_STREAM`; the threads Lambda has `STREAM_URL`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run deploy:local && npm -w services run test:int`, then `npm run dev` and `curl -N "<url from the ticket route>"`.
  - Expected: all pass, and `curl` prints frames as the run writes them.
  - Note the local server in `floci-compat.md`.
- [ ] **Step 5: Commit** `feat(runs): resumable SSE run stream with one-time tickets (Function URL on AWS, local server on Floci)`.

### Task 8: The thread view: steps, streaming answer, steer and Stop [web chain; after Task 3, parallel with Tasks 4–7]

**Files:**
- Create: `web/app/r/[roomId]/t/[number]/page.tsx` (server-fetches the room view + the first history page), `web/app/r/[roomId]/t/new/page.tsx`, `web/components/threads/ThreadView.tsx`, `RunBlock.tsx`, `StepRow.tsx`, `AnswerText.tsx`, `web/lib/client/useRunStream.ts`, `web/lib/client/ThreadsProvider.tsx`
- Modify:
  - `web/components/chat/Composer.tsx`: `steering?: boolean`, `onStop?: () => void`;
  - `web/lib/server/forward.ts` (+ test): the four new routes;
  - `web/app/bff/auth/signup/route.ts`: the usernames `agent` and `everyone` → 400 "That username is reserved."

**Interfaces:**
- Consumes: Task 3, plus step 3's `LiveProvider`, the `ChatView` message list, `MessageText`, `applyMessages` and `bff`.
- **`ThreadsProvider({view})` / `useThreads() → {threads; budget; byNumber(n); byId(id)}`:**
  - seeded from `view`;
  - applies `run.updated` / `thread.updated` via `applyThreadUpdate`, and takes `budget` from `run.updated`;
  - `router.refresh()` on `reconnected`.
- **`useRunStream(runId, live) → RunView`:**
  - `openRunStream`, with `getUrl` = `bff("/bff/api/runs/<id>/stream-ticket", {body:{}}).url`;
  - state flushed to React at most once per `requestAnimationFrame`;
  - dev only: `window.__runStream = {drop}`.

**Behaviour (pinned):**
- **The page:** `groupThread` gives the blocks. User messages are right-aligned bubbles (radius `16 16 6 16`, `bg-surface-3`), and run blocks render `RunBlock`.
- **Live run:**
  - **Rows:** step rows and steer bubbles in event order, then queued steers labelled "queued".
  - **A step row:** a 40 px button with:
    - the icon: a spinner arc while running, a check when done;
    - the mono name, shimmering while running;
    - the detail;
    - the meta on the right: elapsed ticking while running, `ms` when done.
  - **Answer:** `AnswerText` renders the `streamWords` spans, with the headline from `splitHeadline` in Space Grotesk 27 px.
  - **Composer:** placeholder "Steer the agent…", border `#3B5420`, the hint "Enter steers the running agent", and a **Stop** button (square icon, `aria-label="Stop the run"`). Stop calls `live.request("stop", …)`, and an error shows as a toast.
- **Finished run:**
  - **Steps:** a "▸ N steps" toggle (hidden when there are none). Expanding fetches the events with `useRunStream(runId, false)`, and each row toggles its output (`pre`, mono 11.5 px).
  - **Answer:** `MessageText` with the headline split.
  - **Footer:** mono `fake · $0.00 · 0:12`.
  - **Status line** when not `done`: the reason.
- **The swap:** when the answer's `message.new` arrives, the live block becomes the stored one (keyed by `runId`) and the rows collapse.
- **`/t/new`:** a "New thread" heading and the placeholder "Ask @agent anything…". The first send posts `POST /rooms/:x/threads`, then `router.replace` to `/t/<number>`.

- [ ] **Step 1: Write failing tests:**
  - `forward.test.ts` allows `POST /runs/abc/stream-ticket`, `PUT /rooms/r/budget`, `PATCH /rooms/r/threads/t` and `POST /rooms/r/threads`, and refuses `DELETE /rooms/r/threads/t`;
  - signup as `agent` → 400 (route test, fake Cognito).
- [ ] **Step 2: Run** `npm -w web test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm -w web test && npm run check`. Once Tasks 5–7 are merged, check by hand with `npm run dev`: a `tools:2` run streams, collapses and expands; steer and Stop work.
  - Expected: PASS, and the hand check behaves as pinned.
- [ ] **Step 5: Commit** `feat(web): thread view with live steps, streaming answer, steer and stop`.

### Task 9: Shell: thread list, cards, live capsule, "this run", budget, palette, phone [web chain, after Task 8]

**Files:**
- Create: `web/components/threads/ThreadList.tsx`, `ThreadCard.tsx`, `RunCapsule.tsx`, `RunPanel.tsx`, `web/components/shell/BudgetCard.tsx`
- Modify: `web/components/shell/Sidebar.tsx`, `Header.tsx`, `RoomShell.tsx` (wrap in `ThreadsProvider`; a Context tab with `RunPanel` on thread pages), `nav.ts` (+ test), `web/components/chat/MessageRow.tsx`, `web/components/chat/MessageText.tsx` (+ test), `web/components/overlays/CommandPalette.tsx`

**Behaviour (pinned, from `Fluid2.dc.html`):**
- **Sidebar "Agent threads":**
  - **Header:** the label + `N live` (mono) + "+" (opens `/t/new`).
  - **Rows:** from `sidebarThreads`. Each row has:
    - an icon: a lime spinner when running, a sky check when done, a tertiary square when stopped/failed/capped;
    - the name;
    - the mono `threadMeta`, lime when live and tertiary when muted.
  - **Motion:** the highlight is the shared `nav-highlight`, and new rows enter with `row-in`.
  - **Empty state:** step 2's line until a thread exists.
- **Card** (a `MessageRow` with `threadRef.kind === "started"`):
  - **Placement and source:** it grows in under the message and renders from `useThreads().byId`, so it updates in place.
  - **Look:** a `line-strong` border, radius 14, the status icon, then `#N name`.
  - **Content:**
    - running: the step name shimmering + `step N · m:ss`;
    - done: the summary + "Open ▸";
    - otherwise: the reason.
  - **Actions:** "Open", and "Reply", which puts the composer in reply-to-thread mode (frame `threadId`; the chip reads "to #name ✕").
- **Delivered chip:** a mono `→ #name` under the message, linking to the thread.
- **`MessageText` tags:**
  - `#<digits>` matching a known thread → a link chip showing the current `#name`;
  - a chat `#name` → a link to the chat;
  - anything else stays text.
- **Header capsule** (thread pages, `role="status"`):
  - **Shape:** 36 px high, radius 18, black.
  - **Text:** the current step (shimmering), else "thinking"; then "Done", "Stopped", "Failed" or "Budget reached".
  - **Meta:** `step N · m:ss` while running, `N steps · m:ss` after.
  - **Border:** `#1E2427` running, `#34501C` done, tertiary otherwise.
  - **Below 768 px:** the icon + meta only.
- **Rename:** clicking the header name opens an inline input (slugified as you type). Enter sends the PATCH; a 409 → a toast with the server reason, and the name reverts.
- **Right panel "Context" → "This run":** three tiles: steps, elapsed (ticking), and cost (`formatUsd`). With no runs: "Nothing has run here yet."
- **Budget card:**
  - `formatUsd(spent)` / `formatUsd(cap)`;
  - a `budgetFill` bar, lime, and amber at 100; it's the app's only bar;
  - the owner gets a pencil to edit the cap inline ($0–$20, PUT, errors as toasts);
  - a `?` hint: "Resets on <Month 1> (00:00 UTC)".
- **Ctrl K:** "New thread"; every thread as `#N name`, with archived ones under "Archived" (sending in one reopens it); `@agent …` + Enter starts a thread.
- **Phone (< 768 px):**
  - the thread list lives in step 3's drawer;
  - step rows truncate the detail first;
  - Stop stays visible beside Send;
  - no horizontal scroll.

- [ ] **Step 1: Write failing tests:**
  - `MessageText`: `"see #4"` with thread 4 named `pr-check` → a link with text `#pr-check`; `"see #99"` → no link;
  - `navOrder(threads, chats)` puts threads first, and `direction` across the boundary is `"down"`.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm -w web test && npm run check`. Check by hand against `Fluid2.dc.html` with two contexts.
  - Expected: PASS, and the sidebar, card, capsule and budget update live for both users.
- [ ] **Step 5: Commit** `feat(web): live thread list, in-place cards, run capsule, this-run panel, room budget, palette threads`.

### Task 10: End-to-end smoke and the learn doc

**Files:**
- Modify: `scripts/src/smoke.ts` (+ helpers), `docs/learn/README.md` (study-list row), `docs/learn/floci-compat.md`
- Create: `docs/learn/04-agent-threads.md`

**Smoke checks to add** (the real UI; owner A and guest B in isolated contexts; one `check()` each):
1. **Card:** A sends `@agent check PR 41 tools:2` in #general. B sees one card go from running to ✓ in place, and #general gained exactly 1 message.
2. **Thread view:** the card opens `#1 check-pr-41`. 2 step rows collapse to "▸ 2 steps"; expanding shows `Found 3 notes`; the headline reads `Fake answer for`.
3. **Sidebar:** B's row shows the spinner + `step N · m:ss`, then a time.
4. **Steer:** on a `slow tools:2` run, B steers "also check PR 43" → A sees the steer bubble, and the run ends with 3 steps.
5. **Stop:** B (not the starter) stops a `slow words:400` run → "Stopped by guest." within 3 s, with the partial text kept.
6. **Resume:** `window.__runStream.drop()` mid-answer → the next request carries `last-event-id`, and the final text equals the stored answer's.
7. **Rename:** to `pr-review` → B's card and sidebar update; renaming to `general` shows the 409 toast.
8. **Tag delivery:** `#pr-review also docs` in #general → A's message is in the thread, a run starts, and the chip shows.
9. **Budget:** B's `PUT /budget` → 403. A sets the cap to $0 → the next run ends "Budget reached" with the budget text and a full amber bar. A resets it to $3.
10. **Archive:** `lastActivityAt` set 8 days back (DynamoDB write) → gone from the sidebar after a reload, Ctrl K finds it, and sending reopens it.
11. **Numbers:** 5 `POST /threads` at once → distinct, gapless numbers.
12. **Phone:** at 390×844 during a run, no horizontal scroll, and the capsule and Stop are visible.
13. **Motion:**
    - the answer words show ≥ 5 frames in motion;
    - under reduced motion, 0 frames and no shimmer animation;
    - switching threads keeps CLS < 0.02.

**Learn doc `04-agent-threads.md`** (same shape as 03):
- **What was built and how to try it:** `npm run dev` now also starts the stream server; the fake model's directives.
- **The patterns**, each an interview-ready paragraph:
  - durable execution (checkpoint, replay, determinism outside steps);
  - a single-writer event log with sequence numbers;
  - resumable SSE (`Last-Event-ID`, the 15-minute limit, polling vs push);
  - the signal channel vs the data channel;
  - the inbox as a cursor and the atomic close;
  - cooperative cancellation;
  - pre-call budget checks with bounded overshoot, UTC month buckets and integer micro-dollars;
  - atomic counters;
  - name guard items;
  - archive computed on read;
  - a fake model behind a gateway.
- **The rulings and the Floci notes.**
- **"How big companies do it":**
  - ChatGPT and Claude resumable streams;
  - Temporal and Step Functions vs Lambda durable;
  - log-structured agent events;
  - metering and spend guards (Stripe, the OpenAI usage tiers);
  - Slack's thread model.

- [ ] **Step 1: Add the smoke checks;** run `WEB_URL=http://localhost:3100 npm run smoke`. Expected: new checks fail first wherever behaviour is missing; fix, then **all** pass.
- [ ] **Step 2: Write the learn doc** and the study-list row.
- [ ] **Step 3: Run everything:** `npm test`, `npm run check`, `npm -w services run test:int`, `npm run smoke`. Expected: all green.
- [ ] **Step 4: Commit** `test: agent threads end-to-end; docs: step 4 learn doc`.

## Execution order and parallelism
| Wave | Tasks | Why it's safe |
|---|---|---|
| 1 | **1 ∥ 2 ∥ 3**, separate worktrees | Disjoint files: `services/src/{threads,runs,budget}/model.ts`; `services/src/models/*` + `runs/tools.ts`; `web/lib/**` |
| 2 | **4 → 5 → 6 → 7** ∥ **8 → 9** | The backend chain touches only `services/`, `infra/` and `scripts/`; the web chain only `web/`. Inside a chain, tasks share `core-stack.ts` or the shell files, so they run serially |
| 3 | **10** | It needs everything |

Task 8's hand check waits for Task 7's merge.

## Rulings made while planning
| Ruling | Cost if wrong |
|---|---|
| A thread is a chat (`kind:"thread"`), reusing step 3's send, history, search and seqs | If threads need very different message rules, `kind` checks spread, and the split becomes a refactor of `routeSend` and search |
| The steering inbox is a cursor over thread messages, closed by one conditioned transaction; there are no inbox items | Steers that members shouldn't see would need their own items |
| The loop is the only writer of run events (seq resumed from the newest stored event) | A second writer (approvals, step 7) needs an atomic counter on RUN META |
| SSE auth is a one-time ticket in the URL, read with `fetch` (not `EventSource`), with a fresh ticket per reconnect and CORS `*` | Behind CloudFront with cookies (step 11), the ticket is redundant but harmless |
| The stream polls DynamoDB every 250 ms instead of being pushed | ~4 reads/s per open viewer of a live run; at scale, switch to DynamoDB Streams → fan-out |
| `run.updated` goes out at step boundaries and carries the thread summary + budget, so nothing refetches | A bigger frame than a bare "new events" ping, still far under 128 KB |
| A step = one tool call. The 200 cap and "N steps" count tool calls; model calls are checkpointed but not counted | A model looping without tools is bounded only by time and budget |
| Archive is derived from `lastActivityAt` on read; there's no sweeper and no flag | Listing only archived threads reads the room partition (cheap at this scale) |
| Thread names share the chat name guard | A thread can't be named after a chat |
| Only a *leading* `#tag` (or Reply on a card) delivers into a thread | Mid-text tags only link, so `look at #43` never misfires |
| `#name` is stored as `#N`, and the UI renders the current name | `#43` meaning a PR renders as a link when thread 43 exists |
| The people message posts first, then the card attaches via `message.updated` | The card appears ~100 ms after the message (it grows in) |
| Naming runs in the run's first durable step, through the gateway and budget-checked | The name reads `thread-N` for the first second |
| The usernames `agent` and `everyone` are reserved at sign-up | A user already named `agent` (none today) would need renaming |
| Forced closes (stop, cap, limits, fail) leave late steers unanswered | The user sends again to start a new run |
| The streaming answer is plain fading words, swapped for markdown when stored | Markdown answers (step 5) may restyle slightly at the swap |
| Money is integer micro-dollars; caps are $0–$20 | A cap over $20 needs a code change, on purpose |

## Self-review (done while writing)
1. **Spec coverage:**
   - **Threads:** counter, unique names, fake-suggested name, rename, tags, 7-day archive, card, tag delivery → Tasks 1, 4, 5, 6, 9.
   - **Runs:** durable loop, events, `run.updated`, SSE + `Last-Event-ID` + the local server, steer, stop by any member, the 2 h / 200 caps → Tasks 1, 5, 6, 7.
   - **The fake model** behind the gateway → Task 2.
   - **Budgets:** per-call usage, UTC month, pre-call check, owner cap, money-only bar → Tasks 1, 4, 5, 9.
   - **UI and motion** → Tasks 8 and 9 against the motion table.
   - **Left out:** approvals, tools, memory, subagents, agents list, schedules and Map.
2. **Step scan:** every code step names its file, signature and pinned values. Only the `buildContext`, `closeRun` and loop algorithms are spelled out, because the signatures don't determine them.
3. **Type consistency:** these names are pinned once and used everywhere: `ThreadSummary.rev`/`runFirstSeq`/`costMicros`, `startOrSteer(user, roomId, threadId, message)`, `closeRun` → `"closed" | "unread" | "already"`, `useThreads().byId`.
4. **Review Focus:** each of the five is pinned in its owning task (resume in 3, 7 and 10; last-moment message in 5; budget in 1 and 5; wedged thread in 5; removed member in 6 and 7).
5. **Proportion:** 57 KB against step 3's 39 KB, for 10 tasks instead of 8 and a larger scope. The line count is high because every decision gets its own bullet. The only code blocks are the shared contract and the gateway.
