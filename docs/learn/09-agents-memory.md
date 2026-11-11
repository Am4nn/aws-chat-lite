# Step 9: Agents and memory

## What we built
- **Room agents.** Every room has the built-in `@agent` and up to 20 more, made by any member in the room panel's new **Agents** tab. An agent is data, not code:
  - a name (`a-z`, `0-9` and dashes, 2 to 32 characters; `agent`, `everyone` and `schedule` are reserved, and so is any member's username on the day it is made);
  - instructions, up to 4,000 characters;
  - the tool kinds it may use (`github`, `mcp`, `sandbox`, `web`), of those the room offers;
  - a model, or `Room default`.

  Anyone uses any agent. Its creator or an admin edits or deletes it; admins may edit the built-in's instructions, tools and model, but not rename, delete or copy it. A deleted agent's threads are answered by `@agent` from then on, and its schedules are deleted.
- **Picking an agent.** `@researcher go` in a people chat starts a thread for `@researcher` (the first agent the text names). New thread has an agent picker, and Ctrl K's ask takes any room agent. Threads show `@<agent>` on their card, title and sidebar row (the sidebar leaves `@agent` out).
- **Helpers.** A run's agent can hand one sub-task to another room agent with the `delegate` tool. The helper sees only the task, works with its own instructions, tools and model in the same thread, and its final answer comes back as the tool's result. On the Timeline it is one collapsed `researcher  <summary>` step that opens onto the helper's own steps; its approvals show as their own rows, so a write it waits on is always in view. Helpers can't delegate further, and run one at a time.
- **The Map.** A thread's header has a `Timeline | Map` switch. The Map shows one run (the latest, or the one `?run=` names) as lanes, one per agent, with time flowing left to right:
  - a card per tool step, plus the ask, steers and each lane's answer; calls one model turn made share a column, stacked;
  - bezier edges, sky for a hand-off to or from a helper, amber flowing dashes into a step that waits for a member, and a dotted arc while a lane waits for its helper;
  - a bar with `N steps · N helpers · m:ss · $x.xx` and `Where the time went` (thinking, helpers, tools, waiting) by time or cost;
  - a card's details in the panel's **Step** tab: when it started, what it took, its tokens and cost, its output, and Approve / Deny for a waiting one.

  Cards drop in with a slight overshoot and edges draw themselves in; Replay draws the run again. A phone scrolls the Map inside its own box, with the lane labels sticky.
- **Room memory.** Agents save lasting facts with `memory_save`, `memory_update` and `memory_forget`. Every run's system prompt gets the room's memory as it stands at that model call. The **Memory** tab lists the entries newest first with where each came from (`@reviewer in #12 · 2 h ago`, `edited by bea · 5 min ago`); any member edits or deletes one, nobody adds one by hand. At most 50 entries of 280 characters.
- **Schedules.** In the **Schedules** tab any member sets up to 5 per room: a title, an agent, a prompt, a chat, and a cadence from presets (every 1, 2, 3, 4, 6, 8 or 12 hours at a minute; every day, weekdays or one weekday at a time). Admins set the room's time zone (`Asia/Kolkata` by default). Each fire posts a card in the chat and opens a thread `<title>-<mon>-<d>` (in the room's zone) by the `schedule` author, which starts the agent's run, charged to the room's budget. A room whose budget is spent gets `Skipped: the room's budget is spent.` on the schedule's row instead.
- **Copy to another room.** An agent's menu has `Copy to <room>` for every room where you're an admin. The copy keeps only the tool kinds that room offers, takes the next free name there, and brings the agent's schedules switched off, posting into that room's oldest chat. Threads, memory and files stay behind. The toast says what happened: `Copied to ops as @researcher · not connected there: github · 1 schedule copied, off`.
- **The panel's tabs are icons now** (Step, Context, Memory, Agents, Schedules, Files, Connections, Members, Invite, Search), with the active tab's name as the heading, so ten fit a phone.
- **`npm run smoke`** gained 9 checks (`scripts/src/smoke-agents.ts`), two browsers on the fake model:
  1. A creates `@researcher` (web only) in the Agents panel and edits it; B sees it with no Edit or Delete;
  2. B's `@researcher go` in `#general` starts a thread whose card and sidebar row read `@researcher`;
  3. `@agent ask:researcher` shows one collapsed `researcher` step that opens onto the helper's 2 steps;
  4. the Map has the lanes `agent` and `researcher · helper`, sky hand-off edges and cards dropping in on Replay, and a card's details show tokens and cost;
  5. under reduced motion, Replay moves nothing;
  6. at 390×844 the Map scrolls in its own box with no page scroll, the Agents, Memory and Schedules tabs fit, and all ten tabs fit (each at least 24 px wide);
  7. `call:memory_save`'s entry slides into the Memory panel, B edits it, and `@agent recall` answers with the edit;
  8. `Morning digest` (every day at 09:00, `@researcher`, `#general`) reads `Every day at 09:00 · next … 09:00` and switches off and on from its row, and `npm run schedule:fire` opens its card and the thread `morning-digest-<mon>-<d>`;
  9. A copies `@researcher` to a second room: the toast says `· 1 schedule copied, off`, and that room lists the agent with its schedule off.

  Two older checks read text this step changed (a thread's title now ends with its agent, and an answer's footer with ` · Map`) and were updated. The whole smoke passed 115/115 twice in a row on a fresh Floci.

## How to try it
```powershell
npm run deploy:local
npm run dev
npm run schedule:fire -- <roomId> <scheduleId>   # fires a schedule now, as Scheduler would at its time
```
On the fake model:
- `@agent ask:researcher` hands the rest of the prompt to `@researcher` (one `ask:<name>` per delegate call, in order).
- `@agent call:memory_save` saves an entry (`fake`); `@agent recall` answers with the memory lines its system prompt got (`recall tools:0` skips the lookups).
- A schedule's ids are in `GET /rooms/{roomId}/schedules`, or the room's `SCHEDULE#` items.

## How a helper runs
```mermaid
sequenceDiagram
  participant L0 as run loop (lane 0)
  participant D as delegate-<i>-<call> step
  participant C as child context helper-<i>-<call>
  participant E as delegate-end-<i>-<call> step
  L0->>D: delegate {agent, task}
  D->>D: limits; step.started (lane 0); read the full agent; pick its model; helper.started (lane n)
  D-->>L0: the helper's run (lane, task, model)
  L0->>C: runInChildContext
  C->>C: h<n>-model-1, h<n>-tool-1-…, … (the helper's own loop)
  C-->>L0: {status, reason?} (checkpointed)
  L0->>E: finishHelper
  E->>E: helper.finished (lane n); step.finished (lane 0) with the answer read from lane n
  E-->>L0: {steps, costMicros}
  L0->>L0: next model turn sees the answer as the delegate call's result
```

## The patterns
**Agents as configuration.** An agent is a row (`ROOM#<id> / AGENT#<agentId>`): instructions, tool kinds, a model. The run loop is the same code for every agent; the agent decides only the system prompt's second and third lines, which tools are offered (`toolsFor(..., kinds)`), and which model answers. Adding an agent is a write, not a deploy. Three details make that safe:
- **The tool filter is at the offer, and again at the call.** `mayRun` is built on the same `toolsFor`, so a model that names a tool its agent may not use gets `Unknown tool`, not the tool.
- **The agent is read once per run,** in the `load` step, and checkpointed: an edit mid-run applies from the next run, and a replay sees the agent the run started with. The other agents are checkpointed only as cards (id, name, the first line of the instructions), since twenty full instructions would come near the 256 KB checkpoint limit; a helper's whole agent is read when it starts.
- **The built-in is virtual until edited.** Every room has `@agent` without a write at room creation; the first admin edit creates its item, recognised by its key.

**Share by copy, not by reference.** A copy is a new agent in the target room, owned by the copier, with the target's tool kinds. A shared reference would let one room's edit change another room's behaviour, and it would carry the source room's connections and memory along. The trade-off: the two drift apart, which for a team chat is the point.

**Orchestrator and worker: subagents as durable child workflows, one event log in lanes.** The main agent is the orchestrator; a helper is a worker with a narrow task and its own context. Three choices make it durable:
- **A child context, not a second execution.** The helper's loop runs in `ctx.runInChildContext`, inside the parent's durable execution. Its steps are checkpointed under it, and once it ends, its ending is: a replay returns `{status, reason?}` without walking its steps. The child returns only that, never the answer (a child result over the 256 KB checkpoint limit makes it run again on every replay); `finishHelper` reads the answer back from the log. Stop, the step cap, the budget and approvals come free, because the helper is the same run.
- **Lanes in one event log.** Every event a helper writes carries `lane: n`. The main lane's context (`buildContext(..., lane 0)`) sees a helper only as its delegate call's result; the helper's context opens with its task alone. The Timeline folds lane n onto its delegate step; the Map draws it as a lane.
- **Names that can't collide.** Durable step names, approval waits and the run's call markers are keyed by run only, so a helper's are prefixed `h<lane>-`: its `h1-model-1` can never read the main lane's `model-1`.

What it doesn't do: helpers in parallel (a fan-out needs several child contexts at once), and depth beyond 1 (a helper gets no `delegate` tool).

**A helper inherits its parent's privacy class.** A helper's answer flows into its parent's model. A parent on DeepSeek may not see private content, so its helpers get the web alone (`helperKinds`): a helper that read GitHub would taint the thread and the parent's next turn would only refuse. A helper's model is picked like a new run's, kept off DeepSeek when the thread, or the turn that delegated, holds private content.

**Long-term memory: written by tools, read in the prompt.** Memory is a list of short notes the agents save, injected into the system prompt on every model call:
- **No extraction pass.** Nothing summarises a run after it ends; the tool's description is the "extraction prompt", so memory costs nothing extra and holds only what an agent chose to keep.
- **Privacy labels.** An entry saved or rewritten from a thread with private content is marked private, and the mark never comes off. DeepSeek never gets private entries. They are shown only to a model that may see them, in a thread that is already private, so a clean thread never holds private text that it could pass on in a public save, a helper's task or its own answer.
- **Memory as a prompt-injection persistence risk.** Text a model read (a web page, a GitHub issue) could have it save an "instruction" that then sits in every later prompt. The defences are layers, not a wall: the block is framed as notes, not instructions; whitespace folds to one space, so an entry can't forge more `- [id]` lines; members see every entry and its source, and edit or delete it. An injected entry still steers runs until someone deletes it.
- **Bounded.** 50 entries × 280 characters (about 4k tokens per call). The cap is one transaction: the put and a `META` counter `ADD … < :max`.

**Cron in a time zone, and daylight saving.** A schedule's trigger is an EventBridge Scheduler schedule with `ScheduleExpressionTimezone` set to the room's zone, so `09:00` stays 09:00 on the wall clock across a DST change. The zone is stored exactly as picked, checked against the runtime's own list (plus `UTC` and `Asia/Kolkata`, which Node lists as `Asia/Calcutta`), and never canonicalised. The app computes "next" itself, on the zone's wall clock, to match Scheduler: a time the clocks skip in spring has no fire that day; a repeated autumn time fires once.

**At-least-once triggers, made at-most-once with a claim key.** Scheduler delivers at least once. Its `<aws.scheduler.scheduled-time>` placeholder fills the target's input with the occurrence's time, so every redelivery of one occurrence carries the same `at`. The fire handler claims `ROOM#<id> / SCHEDFIRE#<scheduleId>#<YYYY-MM-DDTHH:MM>` with `attribute_not_exists` (and a 7-day TTL) before it writes anything. A second delivery finds the claim and stops (`duplicate`). The trade: a crash after the claim loses that occurrence instead of running it twice.

**Item as truth, with self-retiring triggers.** The schedule item decides; the EventBridge schedule exists only while the item is enabled. Nothing else needs Scheduler rights to keep them in step:
- a fire that finds the item gone, off, pointing at a deleted agent or an archived room deletes its own trigger and returns `retired`;
- every Scheduler failure path ends consistent. Create, enable or a cadence change that Scheduler refuses switches the item off and answers 503; a disable or delete removes the trigger best effort, and a leftover heals itself on its next fire.

**Trace views and DAG views of an agent run.** The Timeline is a trace (one list of spans in time order, children folded under their parent: the LangSmith and Claude Code shape). The Map is a DAG: lanes per agent, columns per model turn, edges for hand-offs and waits. Both are rebuilt in the browser from the same event log the run writes, so the Map needs no API of its own; a run's own `run.started` event names its agent, so an old run reads as it ran even after a rename or delete.

## What the final review changed
- **Editing `@agent` broke the room.** The built-in has no item until its first edit, and that edit wrote one without `agentId`, which the repo recognised the built-in by. The room's agent list then held a nameless phantom (a 500 for the whole room page with any other agent present), and every `@agent` run failed. The built-in's write now sets `agentId`.
- **`timeZone` is a DynamoDB reserved word** and was bare in three expressions, which Floci accepts and AWS refuses: on AWS the Schedules panel, the zone setting and every fire would have failed. They use `#tz` now, and the three repos share one `setFields` helper that placeholders every name.
- **Private memory could leak to DeepSeek through a clean thread.** A Claude run in an untainted thread saw private entries, then could save them as a public entry, hand them to a DeepSeek helper, or leave them in its answer. Ruling: private entries go only to a model that may see them in a thread that is already private.
- **A DeepSeek agent that delegated to a GitHub helper always failed.** The helper tainted the thread and the parent's next turn refused. Helpers now get their parent's privacy class.
- **Smaller ones:** a time the clocks skip now has no fire that day (as Scheduler does); only exact zone names pass; a schedule create that Scheduler refuses closes the form, so a second press can't make a copy; a copy into a room with no chat skips its schedules; the tool calls and the helper's model see the turn's taint, which can be ahead of the thread's stored one; the run checkpoints the other agents as small cards; a run's Map labels its main lane with the agent that ran it. An unknown model in an agent edit was already a 400, and a failed schedule cleanup on agent delete heals itself on each schedule's next fire.
- **The merge with the MCP step** brought per-server MCP taint (`mcp:<name>`) and its `asksFirst` rule. Memory calls stay outside that rule: they never ask, in any thread.

## Rulings
| Ruling | Cost if wrong |
|---|---|
| A helper is a child context of the run's own durable execution and a lane of its event log | Helpers can't outlive the run or run in parallel |
| Helpers can't delegate (depth 1) and run one at a time | A fan-out needs parallel child contexts later |
| Helper steps share the run's step numbers, caps, budget and stop | One long helper can use up the 200 steps |
| A helper of a DeepSeek parent gets the web only; sandbox counts as private (room files) | Such a helper can't run code |
| A helper's model sees the delegating turn's taint as well as the thread's | None known |
| A run checkpoints the other agents as cards (id, name, first line); a helper reads its full agent at start | One more read per delegate call |
| Private memory reaches only a `privateOk` model in a thread that is already private | An agent in a public thread can't use a private note |
| An entry saved or rewritten from a private thread becomes private for good | Nobody can mark it public again; a member can only delete it |
| Memory is written only by tools and member edits; no extraction pass, no manual add | Agents may save less than an automatic pass would |
| Memory calls never ask for approval, in any thread | None known: memory stays in the room |
| The Map's nodes are tool steps plus the ask, steers and answers; a turn's tokens and cost split evenly over its calls | Per-node tokens are an even split, not exact |
| Calls from one turn share a column, though they run one after another | The Map shows "decided together", not true parallelism |
| `run.started` carries the agent's name at the start | A renamed agent's old runs show its old name |
| Agent delete is soft; its threads fall back to `@agent`; its schedules are deleted (best effort) | A failed schedule cleanup holds cap slots until each retires on its next fire |
| An agent name may not be a member's username at create time | A later joiner with that name gets both meanings |
| The first mentioned agent starts the thread | The others are ignored |
| Time zones are stored exactly as picked, from the runtime's list plus `UTC` and `Asia/Kolkata` | A zone the runtime lists but Scheduler refuses saves, then switches schedules off (503) |
| The schedule item is the truth; triggers retire themselves | A stale trigger costs one short invocation |
| Fires are at most once per occurrence (claim first) | A crash after the claim loses that occurrence |
| A fire is skipped when the budget is spent, with the reason on the row | That day has no thread, only the note |
| Scheduled messages are by a reserved `schedule` author; the thread is `<title>-<mon>-<d>` | The display name is a slug, not "Morning digest · Nov 10" |
| A copied schedule posts into the target's oldest chat, switched off; a room with no chat gets none | It may land in `#general` rather than the matching chat |
| Cadences are presets (at most hourly by construction) | No arbitrary cron |
| Ten panel tabs are icon tabs with the label as the heading | Less scannable than words |
| Panels refetch on `agents.changed`, `memory.changed`, `schedules.changed` | One extra GET per change |

## The live run
One Sonnet thread on Floci (`deploy:local -- --live-models`, tools fake, 2026-11-12). The room had `@researcher` on Haiku with the web only, and the thread was sent with Sonnet picked: `@agent ask @researcher what EventBridge Scheduler's flexible time window is, then remember the answer in one line`.
- **What happened.** Sonnet called `delegate` with `{agent: "researcher", task: …}`; the helper ran in lane 1 on Haiku (its own model) and answered in one turn without a tool; Sonnet then called `memory_save` with one line and answered: the window runs a schedule at a random time within a window after its time (never early), `Off` or 1 to 1,440 minutes, to spread load, with a note that `@researcher` answered from memory, not from the docs. The Memory tab got one public entry by `@agent` in #1. Two steps, status done.
- **The bug it found.** The answer ended with "The room already had an identical entry, so the save may have created a duplicate." There was one entry. Memory is read again for every model call, so the turn after the save saw its own new entry in the system prompt and took it for an older one. The fake model never reads the memory block that way. `memory_save` now answers `Saved to room memory as [id]; from your next turn it is listed in the room memory.` (pinned in `memory/tools.test.ts` and `runs/agents.int.test.ts`; not re-run live).
- **What memory costs the cache.** The first Sonnet turn wrote 1,449 tokens to the prompt cache and the second read them back, but the third read none and wrote 2,113: the save changed the system prompt, so everything after it was written again. That last turn was $0.0083 of the run's $0.0160.
- **Spend:** $0.0160 (`run.costMicros` 16,002): naming 17 µ$, Sonnet 4,751 + 2,352 + 8,347 µ$, the Haiku helper 535 µ$. Afterwards the stack was redeployed plain and both `cl-local-model-keys` and `cl-local-tool-keys` were set to `{}`.

## Floci notes
- **Durable child contexts work.** `runInChildContext` checkpoints the helper's steps under the child and the child's result; the execution's history shows `ContextStarted` and `ContextSucceeded` around the `h1-*` steps. A helper waiting on an approval inside the child resumed in a new invocation without starting any step twice. No fallback was needed.
- **Recurring Scheduler cron with a time zone fires at the right wall clock,** and an `UpdateSchedule` in place moves it (a probe in `Asia/Kolkata`, then `America/New_York`). DST can't be watched live.
- **`<aws.scheduler.scheduled-time>` is filled in** (`2026-11-11T15:44:00Z`: whole seconds, no milliseconds), so the claim key works locally as on AWS.
- **`UpdateSchedule`, `GetSchedule` and `DeleteSchedule` on a missing name throw `ResourceNotFoundException`,** so update-then-create and the "already gone" delete work.
- **`npm run schedule:fire`** stands in for waiting on a real cron: it invokes `cl-local-schedule-fire` with `at` = now.
- **Reserved words aren't checked.** `timeZone` is reserved on DynamoDB (`TIMEZONE`), and the final review found it bare in three expressions; Floci ran them all. Every expression now names it through `#tz`.
- **The first full int run on a fresh Floci passed 288/288** (28 files), the step's nine new int files included, with no Floci workaround.
- Details are in the [Floci compatibility report](floci-compat.md).

## Known limits
- **No parallel helpers** and no nested ones.
- **Approval audit entries name no agent;** `asked` and `tool` entries do.
- **Scheduler's DST behaviour is unprobed** (Floci can't show it); the app follows the AWS docs and pins its own side in unit tests.
- **The fire Lambda will need push rights** once push notifications land: a schedule's card and first message count mentions, so a title or prompt with `@someone` or `@everyone` notifies from `cl-<stage>-schedule-fire`.
- **Memory breaks prompt caching mid-run.** Memory is read on every model call, so a save changes the system prompt and the cache of everything after it.
- **A claimed occurrence can be lost** if the handler crashes after the claim, and its card may be left without a thread.
- **A stopped or capped helper ends the run one step late,** at the main lane's next limits check.

## How big companies do it
- **Claude Code subagents:** each subagent is a Markdown file (a name, a description the main agent reads to decide when to delegate, a tool allowlist, a model) and runs in its own context window, returning only its final message. Ours are the same idea stored per room, with the description being the first line of the instructions.
- **OpenAI Agents SDK:** two shapes, *agents as tools* (the orchestrator calls a worker and keeps control, which is our `delegate`) and *handoffs* (control passes to the other agent for the rest of the conversation, which we don't do).
- **ChatGPT and Claude memory:** ChatGPT saves "memories" from chats and shows them in settings for the user to delete; Claude's memory is per project and editable. Both let the user see and remove what was kept, which is the defence against a poisoned note.
- **Slack Workflow Builder schedules:** scheduled triggers in a workspace's time zone that post into a channel, owned by the workspace rather than a person; ours post a card and open a thread.
- **Temporal child workflows and Schedules:** a child workflow has its own history and returns a result to its parent, as our child context does; Temporal Schedules carry an overlap policy and a catch-up window, where we have Scheduler's retry window and a claim key.
- **LangSmith and LangGraph:** LangSmith shows a run as a trace tree with token counts and cost per span; LangGraph Studio draws the graph and the path a run took through it. Our Timeline and Map are those two views.
- **The Step Functions console:** a graph of states coloured by status, with each state's input, output and timing on click, the model for the Map's Step tab.

## Interview angle
- "How would you add subagents to a durable agent loop?" A child context in the same execution, so stop, caps and approvals apply for free; return only a small result from the child and read the answer from the log; prefix the child's step names so they can't collide with the parent's.
- "How do you keep a cheap model from seeing private data through a helper?" Carry taint as data: a helper inherits its parent's privacy class, and its model pick reads both the thread's stored taint and the turn's.
- "Long-term memory for an agent: what can go wrong?" It is a persistence channel for prompt injection. Frame it as notes, keep it small and visible, let people edit and delete it, and label what came from private content.
- "Exactly-once from a scheduler?" You can't; make it at-most-once (or idempotent) with a claim keyed by the occurrence time the scheduler supplies, and decide which side of a crash you prefer.
- "Who owns the truth, the schedule row or the cron?" The row. The trigger exists only while the row says so, and a fire that finds the row disagreeing deletes its own trigger.
