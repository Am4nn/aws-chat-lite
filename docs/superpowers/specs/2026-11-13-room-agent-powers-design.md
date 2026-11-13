# Room agent powers: design

Status: approved by Aman, 2026-11-13. Builds on the chat-lite design (`2026-11-10-chat-lite-design.md`).

## Intent
Today an agent can only answer inside its own thread. Aman wants agents to be real participants of a chat-lite room:
read what's going on, post into channels, set up other agents, so they can run workflows for people (digests, triage,
"tell #general when this is done", setting up a helper agent). This must stay least-privileged and predictable, and
the room decides how much happens without a person approving it.

## Goals
- Agents read their own room through defined tools, with the access a newly joined member has.
- Agents post into any channel of their room, as themselves, clearly marked as an agent.
- Agents create agents, and edit the agents they created.
- Each room picks how much runs without approval: **Ask**, **Auto**, **Bypass**, with a hard floor that always asks.
- Delegate gets a per-agent allowlist.
- chat-lite's own MCP server can't be added as a room connector.
- A curated connector catalog (Linear, Notion) next to "add any MCP server".

## Non-goals (now)
- Skills (a room skill library like Claude Code's SKILL.md). Later.
- Agents acting in other rooms, ever.
- Agents creating, renaming or archiving chats or threads; deleting agents; starting new threads.
- Agents triggering other agents through posts. Other agents are reached only through `delegate`.

## Anti-goals (a failure even if it works)
- Any path where a member gets something done through an agent that the member couldn't do themselves.
- An "admin approval" concept. Every agent action is approvable by any member, or not offered at all.
- An agent message that could pass for a person's.
- Room chat leaking outside through a tool call that nobody approved.
- Agents looping (agent post → agent run → agent post…).

## Decisions

### Identity
- An agent acts as **itself**: one participant with a fixed role equal to what a newly joined member can see and do in
  its room. It is never "as the asker", so automated runs (schedules) and busy threads work the same way.
- Its reach is the room the run belongs to. No tool takes a room id from the model; the room comes from the run.
- Everything it writes is attributed to the agent (`@scout`), with the run's thread and, for approved actions, the
  member who approved. The audit trail records tool, input, decision (ran, asked, approved by whom, denied) and result.

### Three new tool switches, off by default
The room tools come as **three separate tool kinds** on an agent: **Read room**, **Post in channels**, **Manage
agents**. Nobody has them until someone ticks them, the built-in `@agent` included; existing agents get nothing.
"Manage agents" works best with "Read room" but neither requires the other.

### Read tools (Read room)
All read-only, room-scoped, never ask:
- **list chats and threads**: names, numbers, agent, status, last activity; archived ones flagged.
- **read a chat or thread**: the latest N messages or a range, paged; deleted messages come back blank, as members see
  them. Archived chats are readable (members can open them by link).
- **search the room**: the search members use.
- **who's in the room**: members and their roles (so it can @mention people).

Reading room chats marks the run's thread as holding room data (a new taint source), which feeds the hard floor below.
It is not "private" for model choice: people-chat text isn't private today, so it doesn't refuse DeepSeek *(my call)*.
Reading a thread whose own taint is private (GitHub, MCP, sandbox, files) copies that taint into the reading thread,
so private data can't reach a model that may not see it through a second thread *(my call)*. "Read a thread" returns
its messages and answers only, never step logs or tool outputs, as the MCP `read_messages` does *(my call)*.

### Write tools
- **post in a channel** (Post in channels): any non-archived people chat of the room. Shown as `@scout · AI · from #thread-name`, with the
  agent's own name (not the generic "agent"), linking back to the thread. It may @mention people by name, who are notified
  like any mention; never `@everyone`. It must not contain an agent mention or a thread tag that routes: the tool refuses such a post (or
  posts it with routing off; builder's call, but it must never start or steer an agent or deliver into a thread).
  Capped per run: **10 by default**, adjustable by admins **1–50** in room settings.
- **create an agent** (Manage agents): name, instructions, tools, model. The new agent never gets more than its creator:
  its tool kinds, room-tool switches and delegate list are each a subset of the creator's, and it gets "Manage agents"
  only if the creator has it. The model is free (the room budget caps cost). When the request needs more than the
  creator may grant, the tool says so and the agent tells the people what to add by hand.
  The record says it was created by `@scout` and who approved it (in Auto or Bypass, no approver).
- **edit an agent it created** (Manage agents): same fields and bounds; never itself, never one a person made, never
  another agent's.
- **Who owns an agent-made agent**: the creating agent (through the edit tool), the member who approved its creation
  (edits and deletes it as if they had made it), and admins as always.
- Not offered: delete anything, create/rename/archive chats or threads, start a new thread, change room settings.

### Approval modes (per room)
Changed by owners and admins (admins are all-powerful in a room). Default **Ask** for every room, new and existing.
- **Ask**: every write tool shows the approval card, as GitHub writes do today. Any member may approve.
- **Auto**: member-level room writes (post, create agent, edit own agent) run without a card. Everything else follows
  today's rules.
- **Bypass**: every tool call runs without a card, except the hard floor.
- **Hard floor, asks in every mode**:
  - anything that deletes or archives (none of the new tools do; this guards existing and future ones);
  - any call that leaves the room once the thread holds room data from the read tools: web, MCP, image generation,
    GitHub (reads and writes, since a search carries text out), and the sandbox while its internet is on;
  - an agent approving its own request (only people approve).
  - For MCP tools, "deletes" means destructive: a non-read-only MCP tool counts as destructive unless its server marks
    it `destructiveHint: false`, the MCP spec's default. Bypass runs only those marked not destructive.
  - The sandbox's own file work in the room's file space stays as today (never asks); it is not room content.
- The room header and the thread header show a small badge when the room is in Auto or Bypass.
- Existing rules stay: GitHub writes and non-read-only MCP tools are writes; outbound calls in a private (tainted)
  thread ask. In Bypass they run, except where the hard floor applies.

### Loops
- Agent posts never route: they don't start or steer agents and don't deliver into threads.
- Delegate stays the only way an agent reaches another agent: depth 1 as today, helpers can't delegate further.

### Delegate allowlist
- Each agent has a list of agents it may delegate to. **Default: all agents of the room** (today's behaviour). Editors
  of the agent can narrow it in the agent form.
- A helper never gets more tools or power than the agent that called it (today's rule, kept).

### Connectors
- Adding an MCP server whose URL is chat-lite's own `/mcp` (on any configured site origin or the local MCP base) is
  refused, with a message saying why.
- A curated catalog in Connections offers one-click **Linear** and **Notion** (their official remote MCP servers with
  OAuth), alongside the existing "add MCP server" by URL.

## Constraints
- Serverless only, single-table DynamoDB, existing patterns (CLAUDE.md). Tests first.
- Server-side enforcement only: the model's choices never decide what is allowed.
- Works at 390 px wide.
- The fixed agent brief (`AGENT_BRIEF`) gains what the room tools are and the "no agent mentions / thread tags in posts"
  rule.

## Left to the builder
- Tool names, input shapes, paging sizes, the exact taint source name, where the mode and post cap are stored (room
  settings next to the approval timeout is the natural place), how the badge looks within the existing design system.
- Whether a routing mention in a post is refused or neutralised, as long as it never routes.
- How the catalog stores its entries (a static list in code is fine).
