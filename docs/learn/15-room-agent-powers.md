# Step 15: Room agent powers

## What was built
Agents can now read the room they work in, post in its channels as themselves, and set up other agents. How much of
that happens without a person clicking Approve is a room setting: **Ask** (today's behaviour), **Auto** (agents post
and set up agents without asking) or **Bypass** (every agent tool runs without asking, except deletes and calls that
would carry room chat out). Admins set the mode and a cap on posts per run; the header shows a quiet badge in Auto
and Bypass.

- Read tools: `room_list`, `room_read`, `room_search`, `room_members`. They return only this room's data.
- `room_post` posts in a channel as the agent: author `agent`, the agent's name, an AI tag, and a `from #thread` link.
- `agent_create` and `agent_edit` make and change agents, bounded by what the creating agent itself may do.
- An agent's `delegates` list says which other agents it may hand work to.
- A room can't connect to chat-lite's own MCP server (a confused deputy); Linear and Notion are one click in the catalog.

## Things worth knowing
- **The floor is a taint-driven deny rule.** Reading room chat marks the thread (`room` taint), the same data
  classification as private content. After that, calls that would carry the chat out (web calls, internet in the
  sandbox, GitHub, MCP tools) ask a member in every mode, Bypass included, and so does anything destructive. The mode
  loosens the default; the floor is checked first and the mode can't override it. A denied call stays denied.
- **Why posts bypass routing.** A post is stored as a plain agent message and never goes through the mention and
  thread-tag router. Otherwise one agent could start another agent's thread with `@name` or fan out copies with `#3`,
  and a loop of agents could run up cost with no person in it. Posts that try are refused with a message telling the
  model to use `delegate`, which is the one metered, bounded way to reach another agent.
- **Least privilege for agent-made agents.** An agent can give a new agent only tools and delegates it has itself, and
  may edit only agents it created, never itself. Otherwise creating an agent is a privilege escalation: ask the weak
  agent to build a strong one. The refusal names what is missing and says to ask a member.
- **Each post has its own client id.** Rows in the web timeline are keyed by client id, so reusing the run id would
  collide on a second post. Retries are guarded separately: a post whose outcome is unknown is not repeated.
- **Known gaps, kept on purpose.** A helper gets tools by the parent model's privacy rule, not by intersecting with
  the caller's tools, so a DeepSeek parent's helper gets only web and images. An admin turning sandbox internet on
  mid-call applies from the next gate, not to a call already approved.

## How big companies do it
- **Claude Code and Cursor** have permission modes (ask, accept edits, bypass) with a few always-confirm actions that
  no mode skips, and the same split: a default policy plus a hard floor.
- **Slack bots** post through a scoped token as a visibly marked app and can't trigger other apps' slash commands;
  an app's message reaching another app is opt-in.
- **Cloud IAM** forbids creating a role more powerful than yourself (permission boundaries), the same rule as bounding
  agent-made agents.

## Interview angle
"How do you let an agent act without a human in the loop safely?" Make autonomy a per-tenant setting, keep a floor the
setting can't lower and drive it from data flow (what the run has read), cap the agent's power by its creator's, and
route agent-to-agent calls through one metered path instead of free-form messages.

## What to try
Switch a room to Auto, ask `@agent post "hello" in #general`, and watch the AI-tagged row appear. Then have it read a
chat and call the web: the card comes back even in Bypass.
