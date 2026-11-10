# chat-lite: team rooms with shared AI agents, on serverless AWS

Status: draft for Aman's review. Decided with Aman, 2026-11-07 to 2026-11-10 (grill rounds 1–9).
Sibling of `instagram-lite` (same stack and habits; read its `docs/learn/` for the patterns reused here).

## Why
Aman wants two things: to learn how real AI chat platforms are built (WebSockets, resumable SSE, the agent loop, MCP, sandboxes, budgets), and to end up with something he and a few friends actually use day to day, possibly a product.

A plain "chat with a bot in it" isn't new. The angle is **a room where a team and its own shared agents work side by side**. People talk in chats. Agents work in numbered threads. Agents have real tools (a sandbox, GitHub, web, MCP), remember the room, and run on schedules.

## Goals
1. **Rooms are invite-only communities.** Each room has several **people chats** (humans talk, live) and many **agent threads** (each thread is one agent session).
2. **A shared team of agents per room.** Members create named agents and share them by copying them to other rooms.
3. **Agents do real work.** Each room has a sandbox for running code and keeping files. Agents also get GitHub, web search and fetch, and remote MCP servers.
4. **Real AI-platform patterns:**
   - resumable streams, plus steer and stop;
   - an agent loop with subagents;
   - a model gateway with an Auto router;
   - budgets;
   - presence and typing.
5. **Serverless, about $0 when idle.** Always on at `https://chat.amanarya.com`. Built and tested on Floci first.
6. **Each step ships a learn doc that ends with "How big companies do it",** exactly like instagram-lite.

## Non-goals (v1)
- Native mobile apps. The site is a responsive web app plus web push.
- Open sign-up, end-to-end encryption, multi-region.
- An AWS-account tool. Aman dropped it; a room can add AWS's own MCP server later if wanted.
- Semantic or vector search. Basic keyword search only.
- Personal (per-user) tool connections. Connections belong to the room.

## Anti-goals (failure even if it "works")
- Any secret (API keys, GitHub App key, OAuth tokens) inside the sandbox, in a URL, in the browser, or in git.
- Private content (GitHub data, sandbox files) sent to DeepSeek.
- A room able to spend past its cap, or a monthly floor above a few dollars when idle.
- A VPC, NAT or RDS. An always-on server.
- The main people chat flooded with agent output.
- Touching instagram-lite's stack.

## Product shape

### Rooms, people chats and agent threads
```
ROOM "dev-team"   (only Aman creates rooms; people join by invite link)
├─ People chats: # general, # random …   humans talk; can @agent and tag threads
├─ Agent threads: #12 pr-check · reviewer ⏳   #13 morning-digest · morning ✓ …
├─ Agents: @agent (default), @reviewer, @researcher, @morning …
└─ Room panel: Files · Memory · Agents · Schedules · Connections
```
- **People chats** support:
  - live messages, presence and typing;
  - reactions, edit and delete of your own messages (marked "(edited)");
  - attachments (S3), plus unread and @mention badges;
  - basic keyword search across the room's chats and threads.
- **Tagging an agent** in a people chat (`@reviewer check PR 41`):
  - creates a new thread;
  - posts one **card** in the chat that updates in place (`⏳ working…` → `✓ 2 issues ▸ open`).
  - The card never becomes many messages.
- **Tagging a thread** from a people chat (`#pr-check also look at #43`, or "reply" on its card) delivers the message into that thread as that user's message.
- **Agent threads:**
  - **One session per thread.** Each thread is one agent session, and every message typed in it goes to that agent. People don't chat with each other inside threads.
  - **Everyone can follow.** Every room member can see any thread, follow it live, and message it.
  - **Messages sent mid-run steer the run.** They're injected into the running loop at the next step; "Stop" cancels.
- **Thread identity:**
  - **ID:** an incremental number per room (`#1`, `#2`…), allocated concurrency-safe with an atomic DynamoDB counter, so two simultaneous creates never collide.
  - **Name:** a custom name. Haiku suggests one from the first message; anyone can rename it; names are unique per room.
  - **Tagging and display:** both `#12` and `#pr-check` work as tags. Messages store the ID, and the UI always renders the current name.
- **Lifecycle:** a thread auto-archives after 7 days idle. Archived threads are hidden from the sidebar but searchable and reopenable.
- **Subagents:**
  - A thread's agent may hand a sub-task to another agent in the room. The helper runs inside the same thread with only the task it was given, its own instructions and its own tools.
  - It shows as one collapsed step (`▸ researcher: found 3 docs`).
  - There is no cross-thread talk.
- **Agent view in a thread:** the run shows as collapsed "▸ N steps" (each tool call and its output expandable), with the answer streaming below.

### Agents
- **Every room has the default `@agent`;** members can add more.
- **An agent's definition:**
  - name and instructions;
  - tool kinds it may use, chosen from the room's connections;
  - default model;
  - optional schedules.
- **Sharing = copy** into another room where you're an admin. The copy includes:
  - name, instructions and model;
  - tool *kinds*, mapped onto the new room's own connections.
- **Schedules arrive switched off** in the copy.
- **Threads, memory and files are never copied.**

### Room-owned permissions
- **Connections** (GitHub, MCP servers) belong to the room:
  - Admins add them, and every member's agents use them.
  - Each connection is scoped. For example, the GitHub App is installed on chosen repos only.
- **Roles:** the owner is Aman (creates rooms). Admins are set by the owner. Everyone else is a member.
- **Write actions need an approval.** Examples are opening a PR or commenting on an issue. The action shows Approve and Deny buttons in the thread, and **any member** may approve. Reads and anything inside the sandbox need no approval.
- **While waiting for an answer:**
  - The run pauses at no compute cost, and the pause doesn't count toward the 2-hour run cap.
  - The thread's card shows "needs approval", and the room gets a web push.
  - After the **approval timeout** (default **2 hours**, adjustable per room by admins), the action is skipped and the run continues and finishes with a note.
  - Scheduled runs behave the same way.
- **Audit log** per room records:
  - who asked which agent to do what;
  - which tools ran;
  - who approved what.

### Memory and schedules
- **Room memory:**
  - Agents save key facts and decisions automatically (a memory tool).
  - A Memory panel lists the entries; any member can edit or delete them.
  - Memory goes into every agent run in that room.
- **Scheduled jobs** ("@morning every day 9am: digest of new PRs and issues"):
  - any member can create them;
  - at most 5 per room, and none more often than hourly;
  - each run creates a new thread ("Morning digest · Nov 10") and posts a card in a chosen chat;
  - each run is charged to the room's budget.

### Notifications
Web push when you're @mentioned, or when a thread you started finishes or needs an approval. This works on Android and desktop, and on iPhone once the site is added to the home screen. Badges show in the app.

## Agent capabilities

### Tools (v1)
| Tool | What | Notes |
|---|---|---|
| Sandbox | Shell, Python/Node, room files | One file workspace per **room**, persisted in S3 (100 MB per room). Each thread gets its own sandbox session; room files are synced in and out through S3, and if two threads write the same file the last write wins (noted in the run log). *(my call)* Local: a Docker container. AWS: Bedrock AgentCore Code Interpreter. No secrets inside. **Internet off by default** (AgentCore `SANDBOX` mode, S3 only); a room admin can switch the room to internet-on (`PUBLIC` mode) so `pip install` and `git clone` work. A filtered allowlist would need a VPC, which is ruled out. |
| GitHub | Read repos, issues and PRs; writes behind approval | A GitHub App installed on chosen repos. Short-lived installation tokens are minted per call **outside** the sandbox. |
| Web | Search and fetch | Tavily (free tier, about 1,000 searches a month) plus our own fetch tool. Results are cited. |
| Remote MCP | Any MCP server by URL | Streamable HTTP + OAuth, like Claude.ai connectors. Added per room by admins. |
| Memory | Save, update and forget room facts | Shown in the Memory panel. |
| Images | Generate an image | Gemini image model, per-image cost. Verify current model, price and free tier before building. |
| Subagent | Delegate to another room agent | Runs inside the same thread. |

**Inputs and outputs:**
- **Pasted or uploaded images** are understood through Claude vision.
- **Voice in** uses Amazon Transcribe (streaming).
- **Voice out** uses Amazon Polly ("read aloud" on any agent answer).

### chat-lite as an MCP server
chat-lite also **is** an MCP server: Streamable HTTP plus OAuth, with Cognito holding the users. MCP clients (Claude Desktop, Claude.ai) expect to register themselves automatically, either through dynamic client registration or client metadata documents, and Cognito supports neither. So a **thin OAuth layer** of our own sits in front of Cognito: registration plus authorize and token endpoints that delegate sign-in to Cognito. *(my call; gets its own tests and learn doc)*
- **What it allows:** Claude Code or Claude Desktop can list rooms, read chats and threads, post a message, and start a thread. For example, Claude Code posts "deploy done" to `#general`.
- **Scope:** limited to the rooms the signed-in user belongs to.

### Model gateway
- **One internal interface** in front of Anthropic (Claude), DeepSeek and Gemini. It covers streaming, tool calls, and cost per call.
- **The picker** sits next to the message box: `Auto · Sonnet · Haiku · Opus · DeepSeek`. Admins set the room default, and anyone can override it per message.
- **Auto** makes one cheap router call per message:
  - simple chat or summaries go to Haiku or DeepSeek;
  - tool use, code and multi-step work go to Sonnet;
  - **Auto never picks Opus.** Opus is manual only, at about 5× Sonnet's cost.
- **Privacy rule:**
  - **What taints a thread:** once it has touched private content, it is *tainted*. Private content means GitHub data, sandbox files, MCP tool output, or attachments.
  - **What follows from that:** the gateway refuses to route a tainted thread to DeepSeek, whether by Auto or by a manual pick.
  - **Memory:** entries saved from a tainted thread are marked private and left out of any DeepSeek call. They do not taint other threads.
  - **The Auto router** always runs on Claude Haiku, so private text never reaches DeepSeek just to be classified.
  - **Small jobs:** titles, summaries and memory notes may use DeepSeek only on untainted text.
- **Every answer shows** the model used and its cost.
- **Keys:**
  - **Anthropic** API key, paid from Aman's Claude Console credits: about $100, with a $10/month Console limit as the outer guard.
  - **DeepSeek and Gemini** keys from his own credits.
  - **Storage:** keys go in Secrets Manager on AWS and in a gitignored `.env` locally, never in chat or git.
- **Fake model:** a streaming fake model, selectable locally, for development and load tests. Floci never calls a real model unless a key is set.

### Budgets and limits
- **$3 per room per month.** Usage is metered per model call: tokens × price, plus image, Transcribe, Polly and sandbox seconds.
  - **Checked before every model call.** When the cap is hit, the run stops with a clear message.
  - **Overshoot:** concurrent runs can overshoot by at most the calls already in flight, which is acceptable.
- **Only Aman creates rooms,** so total spend = rooms × $3.
- **Run limits:** 2 hours and 200 steps per run. There is **no** concurrency limit per room (Aman's call); the $ cap is the guard.
- **Rate limits:** messages per user per minute, to stop spam, plus WebSocket connection-rate protection.

## Architecture (serverless, same stack as instagram-lite)
```
Browser ── https://chat.amanarya.com ── CloudFront
   /_next/static/*  → S3            pages → Next.js on Lambda (OpenNext, cookie BFF, as lite step 9)
   /runs/*/stream   → SSE Lambda (Function URL, response streaming)   resumable agent output
   wss://…          → API Gateway WebSocket API → Lambdas              chat, presence, typing, "run updated" signals
   /mcp             → MCP server Lambda (Streamable HTTP + OAuth)
                        │
   DynamoDB single table: rooms, members, chats, messages, threads (+counter), runs, run events,
                          agents, connections, memory, schedules, usage, audit, ws connections
   Agent run = Lambda durable function (checkpoint per step, survives > 15 min, up to the 2 h cap)
     → model gateway (Anthropic / DeepSeek / Gemini) → tools (sandbox: AgentCore | Docker, GitHub, Tavily, MCP)
   EventBridge Scheduler → scheduled agent runs.   S3: attachments + room files.   Secrets Manager: keys.
```
- **People messages:**
  - The browser sends over WebSocket to a Lambda, which writes to DynamoDB.
  - That Lambda fans out to the room's connections with `postToConnection`.
  - Connections are stored per room.
- **Agent runs:**
  - A run appends ordered **run events** (sequence numbers) to DynamoDB.
  - The WebSocket only signals "run X has new events" to the room.
  - Browsers following a thread read `GET /runs/{id}/stream` as **SSE**. On reconnect, `Last-Event-ID` resumes exactly where they left off; this is the resumable-stream pattern ChatGPT and Claude use.
- **Steering:** a message to a running thread goes into the run's inbox, and the loop reads the inbox between steps. Stop is a flag the loop checks.
- **Known AWS limits to design around:**
  - WebSocket connections last at most 2 h and drop after 10 min idle, so the client heartbeats and reconnects automatically.
  - WebSocket route integrations time out at 29 s, so route handlers stay fast and agent work happens asynchronously.
  - A Lambda response stream lasts at most 15 min, so SSE clients reconnect with `Last-Event-ID`.
  - Lambda durable functions launched in December 2025 and support Node.js.
- **Prompt injection:**
  - Tool results (web pages, repo files, MCP output) are treated as data.
  - The sandbox has no secrets and limited egress.
  - Writes need approval, and the taint rule protects private data from DeepSeek.

## Floci first
- **Spike first,** like lite step 1:
  - Does Floci emulate the API Gateway WebSocket API with `postToConnection`?
  - Lambda response streaming for SSE?
  - Lambda durable functions?
  - EventBridge Scheduler?
- **The spike also checks the real account,** read-only and by Aman or in front of him:
  - Are Lambda durable functions available in Sydney? AWS listed Sydney in December 2025.
  - Does the Free plan allow AgentCore Code Interpreter there?
  - If either is blocked, the run engine becomes **one** loop that keeps its own checkpoints in DynamoDB and re-invokes itself before 15 minutes, used on both Floci and AWS, so there's one engine, not two. If AgentCore is blocked, the AWS sandbox falls back to a Lambda container image. *(my call)*
- **Every gap gets a local substitute** and a line in `docs/learn/floci-compat.md`. For example:
  - a small local WebSocket server that calls the same handlers;
  - a plain Lambda loop with checkpoints in DynamoDB.
- **The sandbox locally is Docker,** one container per room with a mounted workspace. The AWS adapter is AgentCore. Both sit behind one `Sandbox` interface.

## Proposed steps (each: learn doc, tests, Aman's OK before the next)
1. **Skeleton and spikes:** repo, CDK app, Floci spike (WebSocket, streaming, durable, scheduler), `floci-compat.md`.
2. **Auth and rooms:** Cognito, invite links, roles, room and people-chat CRUD, the sidebar layout.
3. **Live people chat:** WebSocket send and fan-out, presence, typing, reconnect and heartbeat, then reactions, edit and delete, attachments, unread and mention badges, search.
4. **Agent threads with the fake model:**
   - thread counter, names and cards;
   - durable run loop, run events and resumable SSE;
   - steer and stop;
   - budgets and metering;
   - the collapsed-steps UI.
5. **Model gateway:** Claude (Sonnet, Haiku, Opus), Auto router, DeepSeek with the taint rule, cost display, and a load test with the fake model.
6. **Sandbox:** the Docker adapter, room files in S3, the Files panel, then the AgentCore adapter.
7. **Tools and approvals:** the GitHub App, Tavily and fetch, Approve/Deny, the audit log.
8. **MCP:** a remote MCP client per room (OAuth), then chat-lite as an MCP server.
9. **Agents and memory:** the agents list, sharing by copy, subagents, room memory, scheduled jobs.
10. **Media and notifications:** voice in and out, Gemini images, image understanding, web push.
11. **Real AWS:** `chat.amanarya.com` (Spaceship DNS plus an ACM cert in us-east-1, as with lite), Secrets Manager, ops dashboard and alarms, then a live test with invited friends.

## Repo and secrets
- `C:\Aman\Coding-Bamzii\Web Development\aws\chat-lite`, public at `github.com/Am4nn/aws-chat-lite` from day 1. It's pushed only when Aman says so.
- From the first commit, `.env*`, `infra/cdk.context.json` and anything with keys are gitignored, and a secret scan runs before each push.
- **Same AWS account** (Sydney, Free plan credits) as a **separate stack.** instagram-lite stays untouched.

## Left to the builder
- Exact DynamoDB key design, file layout, and API route shapes.
- The router prompt and thresholds for Auto.
- The memory-extraction prompt.
- The search index design (within "basic keyword, no extra service").
- UI details within "calm, clean, no AI-slop effects".
- Which Floci substitutes to use where the spike fails.
