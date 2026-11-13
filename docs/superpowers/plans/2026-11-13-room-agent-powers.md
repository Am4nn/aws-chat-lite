# Room Agent Powers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents become room participants. They read their room, post into its channels as themselves, and create and edit the agents they made. Each room picks **Ask / Auto / Bypass** for how much runs without a member's approval, and a hard floor always asks. Delegation gets a per-agent allowlist, chat-lite's own `/mcp` can't be added as a connector, and Connections offers one-click Linear and Notion.

**Architecture:**
- **Three new tool kinds** (`room_read`, `room_post`, `room_agents`) ride the existing `Tool` registry (`services/src/tools/room/`). Every tool takes its room from the run's `ToolEnv.room`, never from the model. Read tools never ask. Room write tools are `write: true`, so today's gate already asks for them in Ask mode.
- **One gate decides everything:** `asksFirst(tool, taint, { mode, sandboxInternet })` in `runs/tools.ts` checks the hard floor first (destructive, or an outbound call once the thread holds the new `"room"` taint), then the room's mode, then today's rule. `gateOf` reads the mode, the post cap and `sandboxInternet` from room META through `connectionsRepo().get`. A new `SANDBOX_GATE` puts `sandbox_run` behind the floor.
- **Agent posts never route.** `room_post` calls `chatRepo().send` directly as author `agent` with `agentPost: { threadId, number }`, like a schedule's card. It never calls `routeSend`, `startOrSteer` or `createThread`. Agents are reached only through `delegate`, now filtered by `Agent.delegates`.

**Tech Stack:** The existing stack: TypeScript strict, Lambda + single-table DynamoDB (lib-dynamodb), durable execution SDK, Next.js + React + Tailwind + motion, vitest, CDK. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-11-13-room-agent-powers-design.md` (approved, binding). Read all of it. Also read `CLAUDE.md`, and skim the step 7 plan's Global Constraints (`docs/superpowers/plans/2026-11-11-step7-tools-approvals.md`) for the approval machinery this plan extends.

## Global Constraints
- **CLAUDE.md applies:** least code, no dead code or unused exports, why-comments only (never a step/task/plan reference), TDD, and `npm run check` (knip + eslint + tsc in every workspace) passes at the end of every task. Edit files with the Edit tool. Scan the staged diff for secrets before each commit. End each commit with the session's attribution lines.
- **No Floci per task.** Each task runs its unit tests plus `npm run check`. Int tests are marked **(int, written, run batched)**: write them, but the controller runs Floci, the int suite and the smoke run once, together, after the last task.
- **Server-side enforcement only.** The model's input never chooses the room, the author, the approver, or what is allowed.
- **Kinds are off by default:** the built-in `@agent` keeps `BUILT_IN.tools` = the five existing kinds. Existing agents get nothing. A new agent in the form starts with the room kinds unticked.
- **Approval mode:** room META `approvalMode`, `"ask" | "auto" | "bypass"`, absent = `"ask"`. Owners and admins change it (`can("manageConnections")`).
- **Post cap:** room META `postCap`, absent = **10**, an integer **1–50**, else `ValidationError("The post cap is 1 to 50 posts a run.")`. It counts the successful `room_post` steps across every lane of one run.
- **Taint:** the new source is `"room"`, and it is **not private**: `isPrivate(taint)` ignores it everywhere a check means "may DeepSeek see this" or "is this thread private" (refusals, `resolvePick`, the memory `private` flag, the header lock, the model menu).
- **Hard floor, asks in every mode:**
  - a `destructive` tool (an MCP tool that isn't read-only, unless its snapshot says `destructiveHint === false`);
  - once the thread's taint includes `"room"`: any `web`, `mcp`, `images` or `github` call (reads too), and `sandbox_run` while `sandboxInternet` is on.
  - Approvals are by people only, and `approvalsRepo().decide` already requires a member item.
- **Modes:** `ask` = today's rule (every write asks, and web/MCP/image calls ask in a private thread). `auto` = `room_post` and `room_agents` calls run without a card; everything else follows `ask`. `bypass` = only the floor asks.
- **Phone width 390 px.** Calm UI: no glow, short labels, `?` hints for explanations.
- **Copy (exact):**
  - Post refusals: `Posts can't use @everyone.` · `Posts can't mention agents (@<name>). Hand work to an agent with delegate.` · `Posts can't tag threads (#<tag>). Name the thread without the #.` · `There's no chat #<x> here. Chats: #a, #b.` · `#<x> is archived.` · `A post needs text.` · `This run has made its <n> posts, the room's cap per run.`
  - Titles: `Post in #<chat>: "<first 80 chars>"?` · `Create @<name> (<kinds joined ", " | "no tools">)?` · `Change @<name>?` · `Run <language> in the sandbox with internet access?`
  - Results: `Posted in #<chat> (message <seq>).` · `Created @<name>.` · `Changed @<name>.`
  - Agent refusals: `@<creator> can't give what it doesn't have: <items>. Ask a member to add it by hand.` (items are kinds, then `@agent` names, then `any agent` when it asks for all delegates without having them, joined `, `) · `@<creator> can edit only the agents it created, never itself.`
  - Self-MCP: `That's chat-lite's own MCP server. A room can't connect to itself; its agents reach the room through their room tools.`
  - Mode badge titles: Auto `Auto: agents post and set up agents without asking.` · Bypass `Bypass: agent tools run without asking, except deletes and calls that would carry room chat out.`
  - Audit details: mode `Agent approvals: Ask|Auto|Bypass` · cap `Agent posts per run: <n>`.
- **Catalog URLs (verified 2026-11-13 against linear.app/docs/mcp and developers.notion.com):** Linear `https://mcp.linear.app/mcp`, Notion `https://mcp.notion.com/mcp`. Both are Streamable HTTP with OAuth.
- **Fake-model directive for tests and smoke:** `call:<tool>` makes the fake model call that offered tool once, with the smallest input its schema accepts (each required string is `"fake"`). So `call:room_post` posts `"fake"` into the chat named `fake`.

## Review Focus
1. **A post that would route.** `@reviewer can you look`, `see #12`, or `#pr-check` (a thread's name) is refused before any approval. `` `@reviewer` `` inside code, `#general` (a chat's name), and `@bea` (a person) pass, and `@bea` is notified. Pinned in Task 6 (`postRefusal`).
2. **Room data leaving after a read.** A helper lane reads the room, then calls `web_fetch` in a Bypass room: the call asks, because the taint is on the thread, not the lane. A GitHub *read* asks too, and the sandbox asks only while internet is on. Pinned in Task 3 (`asksFirst` matrix, `gateOf` with a helper run).
3. **Model choice after a read.** A thread whose only taint is `"room"` still offers DeepSeek: no `PICK_REFUSED`, no header lock, and memory saved there isn't private. Reading a GitHub-tainted thread copies `github` into the reader. Pinned in Task 1 (`isPrivate`) and Task 5 (taint copy).
4. **Post cap.** A failed or refused post doesn't count. Posts by a helper lane do count. The 11th post (cap 10) is refused by `check`, so no card is shown. Pinned in Task 6 (`postsMade`, `check`).
5. **Escalation through agent-made agents.** `agent_create` can't grant a kind or a delegate its creator lacks. `agent_edit` can't widen past the creator's tools *as they are now*, can't touch the creator itself, a person's agent or the built-in, and a non-member can't approve. Pinned in Task 8.

---

### Task 1: Kinds, the non-private `room` taint, and the shared types

**Files:**
- Modify: `services/src/threads/types.ts`, `services/src/agents/model.ts`, `services/src/agents/kinds.ts`, `services/src/models/privacy.ts`, `services/src/models/picks.ts`, `services/src/runs/model-turn.ts:106`, `services/src/runs/tool-step.ts:66`, `services/src/runs/approval.ts` (the env's `tainted`), `services/src/chat/model.ts`
- Modify: `web/lib/types.ts`, `web/lib/client/models.ts`, `web/components/shell/Header.tsx`
- Test: `services/src/agents/model.test.ts`, `services/src/agents/kinds.test.ts` (new), `services/src/models/privacy.test.ts`, `services/src/models/picks.test.ts`, `web/lib/client/models.test.ts`

**Interfaces:**
- Produces (services `threads/types.ts`, mirrored in `web/lib/types.ts`):
  - `ToolKind = "sandbox" | "web" | "github" | "mcp" | "images" | "room_read" | "room_post" | "room_agents"`
  - `ApprovalMode = "ask" | "auto" | "bypass"`
  - `Delegates = "all" | string[]` (agent ids)
  - `Agent += { delegates?: Delegates; madeBy?: { agentId: string; name: string } }`. Absent `delegates` = `"all"`. On an agent made by an agent, `createdBy`/`createdByName` are the approving member's, or `""` when the mode let it run without a card.
  - `McpToolInfo += { destructive?: boolean }`. Absent = destructive (snapshots taken before the field existed).
  - `AuditKind += "mode" | "cap"`
  - `Message += { agentPost?: { threadId: string; number: number } }` (in `chat/model.ts`, and in web `Message`)
  - `TaintSource += "room"` (also in web)
- Produces (`agents/model.ts`): `BASE_KINDS: ToolKind[]` (the five existing kinds), `ROOM_KINDS: ToolKind[] = ["room_agents", "room_post", "room_read"]`. `BUILT_IN.tools = BASE_KINDS`. `toolKinds(raw)` accepts all eight.
- Produces (`models/privacy.ts`): `ROOM_TAINT: TaintSource = "room"`, `privateOf(taint: TaintSource[]): TaintSource[]`, `isPrivate(taint: TaintSource[]): boolean`. Web `lib/client/models.ts` gets the same `isPrivate`.

- [ ] **Step 1: Write the failing tests**

```ts
// agents/model.test.ts
it("keeps the room kinds off the built-in @agent, and accepts them on any agent", () => {
  expect(BUILT_IN.tools).toEqual(["github", "images", "mcp", "sandbox", "web"]);
  expect(toolKinds(["room_post", "web", "room_read"])).toEqual(["room_post", "room_read", "web"]);
  expect(() => toolKinds(["room_admin"])).toThrow("Unknown tool kind.");
});
// agents/kinds.test.ts (new, mocks connectionsRepo().get → { github: null, mcp: [] })
it("offers the room kinds in every room", async () => {
  expect(await availableKinds("R")).toEqual(expect.arrayContaining(["room_read", "room_post", "room_agents"]));
});
// models/privacy.test.ts
it("doesn't count room chat as private: DeepSeek stays on", () => {
  expect(isPrivate(["room"])).toBe(false);
  expect(isPrivate(["room", "github"])).toBe(true);
  expect(privateOf(["github", "room"])).toEqual(["github"]);
  expect(pickRefusal("deepseek-flash", ["room"])).toBeNull();
  expect(runRefusal(modelIdOf("deepseek-flash"), ["room"])).toBeNull();
});
// models/picks.test.ts
it("keeps a DeepSeek room default on a thread that only read the room", () => {
  expect(resolvePick(undefined, "deepseek-flash", ["room"])).toEqual({ pick: "deepseek-flash", by: "default" });
});
// web lib/client/models.test.ts
it("leaves DeepSeek enabled and hints nothing for room-only taint", () => {
  expect(pickMenu(models, { value: "auto", roomDefault: "auto", taint: ["room"], isAdmin: false }).privateNote).toBe(false);
  expect(isPrivate(["room"])).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/agents src/models/privacy.test.ts src/models/picks.test.ts` and `npm -w web run test -- lib/client/models.test.ts`
Expected: FAIL (`toolKinds` refuses `room_post`, `isPrivate` not exported).

- [ ] **Step 3: Implement** the types above. Use `isPrivate`/`privateOf` in place of `taint.length > 0` in `pickRefusal`, `runRefusal`, `resolvePick`, the `privateOk` flag in `model-turn.ts`, the `tainted` flag in `tool-step.ts` and `approval.ts`, and in web `pickMenu`, `shownPick`, `taintHint` (lists private sources only) and `Header` (lock only when private). `availableKinds` appends `ROOM_KINDS`. Update the `ThreadSummary.taint` doc comment: `"room"` means the thread read room chat, which isn't private. Leave `start.ts` `threadAdds` alone: it only adds to the set.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`
Expected: PASS. tsc stays green because every new field is optional.

- [ ] **Step 5: Commit** `feat(agents): room tool kinds and a non-private room taint`

---

### Task 2: Room approval mode and post cap (settings API)

**Files:**
- Modify: `services/src/approvals/model.ts`, `services/src/connections/repo.ts`, `services/src/connections/handler.ts`, `services/src/rooms/repo.ts` (`RoomView`), `infra/lib/connections.ts`, `web/lib/server/forward.ts`, `web/lib/types.ts` (`RoomView += approvalMode`)
- Test: `services/src/approvals/model.test.ts`, `services/src/connections/handler.test.ts`, `services/src/connections/repo.int.test.ts` (int, written, run batched), `infra/lib/connections.test.ts`, `web/lib/server/forward.test.ts`

**Interfaces:**
- Consumes: `ApprovalMode`, `AuditKind` "mode" | "cap" (Task 1).
- Produces:
  - `approvals/model.ts`: `DEFAULT_POST_CAP = 10`, `approvalModeOf(raw: unknown): ApprovalMode` (else `ValidationError("Pick ask, auto or bypass.")`), `postCapOf(raw: unknown): number`.
  - `connectionsRepo().get(roomId)` → `{ github, mcp, approvalTimeoutSec, approvalMode, postCap, sandboxInternet }`, all from the META read it already makes. So `roomConnections(roomId)` in `runs/steps.ts` carries them too.
  - `connectionsRepo().setApprovalMode(user: User, roomId: string, raw: unknown): Promise<ApprovalMode>` and `setPostCap(user: User, roomId: string, raw: unknown): Promise<number>`. Each goes through `requireManager` + `withAudit` (kinds `mode` / `cap`, detail copy from Global Constraints), like `setApprovalTimeout`.
  - HTTP: `PUT /rooms/{roomId}/approval-mode {mode}` → `{approvalMode}` and `PUT /rooms/{roomId}/post-cap {cap}` → `{postCap}`, both broadcast `room.updated`. `GET /rooms/{roomId}/connections` adds `approvalMode, postCap`. `getRoomView` adds `approvalMode` (absent = `"ask"`) for the header badge.

- [ ] **Step 1: Write the failing tests**

```ts
// approvals/model.test.ts
it("takes ask, auto or bypass, and a post cap of 1 to 50", () => {
  expect(approvalModeOf("bypass")).toBe("bypass");
  expect(() => approvalModeOf("yolo")).toThrow("Pick ask, auto or bypass.");
  expect(postCapOf(1)).toBe(1);
  expect(postCapOf(50)).toBe(50);
  for (const bad of [0, 51, 2.5, "10"]) expect(() => postCapOf(bad)).toThrow("The post cap is 1 to 50 posts a run.");
});
// connections/handler.test.ts (the repo is faked, as the file already does)
it("sets the mode and the cap for an admin and tells the room", async () => {
  expect(await call("PUT /rooms/{roomId}/approval-mode", { mode: "auto" })).toMatchObject({ statusCode: 200, body: { approvalMode: "auto" } });
  expect(await call("PUT /rooms/{roomId}/post-cap", { cap: 25 })).toMatchObject({ statusCode: 200, body: { postCap: 25 } });
  expect(notified).toEqual(["R", "R"]);
});
// connections/repo.int.test.ts (int, written, run batched)
it("a room starts in Ask with a post cap of 10; an admin's change round-trips and is audited once", async () => {
  expect(await repo.get(roomId)).toMatchObject({ approvalMode: "ask", postCap: 10, sandboxInternet: false });
  await repo.setApprovalMode(owner, roomId, "bypass");
  await repo.setPostCap(owner, roomId, 3);
  expect(await repo.get(roomId)).toMatchObject({ approvalMode: "bypass", postCap: 3 });
  expect((await auditRepo().list(roomId)).entries.map((e) => e.detail)).toEqual(expect.arrayContaining(["Agent approvals: Bypass", "Agent posts per run: 3"]));
});
it("a member changes neither, and nothing is logged", ...);   // Forbidden "Only admins can change the room's connections."
// infra/lib/connections.test.ts: add both route keys to the ROUTES list the existing test walks (JWT, same Lambda).
// web/lib/server/forward.test.ts: ["PUT", ["rooms","r","approval-mode"], "/rooms/r/approval-mode"] and the same for post-cap.
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/approvals/model.test.ts src/connections/handler.test.ts`, `npm -w infra run test -- lib/connections.test.ts`, `npm -w web run test -- lib/server/forward.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the functions, routes and fields with the signatures above. Store the values as META `approvalMode` and `postCap`.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `feat(rooms): approval mode and agent post cap settings`

---

### Task 3: The gate: modes, the hard floor, MCP `destructive`, the sandbox gate

**Files:**
- Modify: `services/src/tools/types.ts` (`Tool += destructive?: boolean`), `services/src/mcp/client/remote.ts` (`toolInfo`), `services/src/mcp/client/tools.ts` (`mcpTool`), `services/src/runs/tools.ts`, `services/src/runs/approval.ts`, `services/src/runs/tool-step.ts`
- Modify (web mirror): `web/lib/types.ts` `McpToolInfo`
- Test: `services/src/runs/tools.test.ts`, `services/src/runs/approval.test.ts`, `services/src/runs/tool-step.test.ts`, `services/src/mcp/client/remote.test.ts`, `services/src/mcp/client/tools.test.ts`, `services/src/approvals/repo.test.ts`, `services/src/runs/approval.int.test.ts` (int, written, run batched)

**Interfaces:**
- Consumes: `ROOM_TAINT`, `isPrivate`, `ApprovalMode` (Task 1); `roomConnections()` now carrying `approvalMode`, `sandboxInternet` (Task 2).
- Produces:
  - `runs/tools.ts`: `type Gated = Pick<Tool, "spec" | "write" | "destructive"> & { kind: Tool["kind"] | "images" | "sandbox" }`.
  - `asksFirst(tool: Gated, taint: TaintSource[], rules: { mode: ApprovalMode; sandboxInternet: boolean }): boolean`. It checks the floor, then `bypass` → false, then `auto` with kind `room_post`/`room_agents` → false, then today's rule. Today's rule counts only `privateOf(taint)` (minus the MCP server's own taint, as now).
  - `SANDBOX_GATE = { spec: SANDBOX_TOOL, kind: "sandbox", write: false, ask: (input) => \`Run ${input.language} in the sandbox with internet access?\` } as const`.
  - `mcpTool` sets `destructive: !info.readOnly && info.destructive !== false`. `toolInfo` stores `destructive: t.annotations?.destructiveHint !== false`.
  - `gateOf` always reads the thread's taint (writes too, since the floor needs it), uses `IMAGE_GATE`, `SANDBOX_GATE` or `findTool`, and passes `{ mode: room.approvalMode, sandboxInternet: room.sandboxInternet }`.
  - `toolStep`: a sandbox call that asked runs only once approved. A declined one returns `unapproved(settled)` and adds no `sandbox` taint, as images do today.

- [ ] **Step 1: Write the failing tests**

```ts
// runs/tools.test.ts — describe("asksFirst")
const ask = { mode: "ask", sandboxInternet: false } as const;
const auto = { ...ask, mode: "auto" } as const;
const bypass = { ...ask, mode: "bypass" } as const;
it("keeps today's rule in Ask, room writes included", () => {
  expect(asksFirst(tool("github_comment"), [], ask)).toBe(true);
  expect(asksFirst({ ...roomTool("room_post"), write: true }, [], ask)).toBe(true);
  expect(asksFirst(tool("web_fetch"), ["attachment"], ask)).toBe(true);
  expect(asksFirst(tool("web_fetch"), [], ask)).toBe(false);
});
it("lets posts and agent setup run on their own in Auto, and nothing else", () => {
  expect(asksFirst({ ...roomTool("room_post"), write: true }, [], auto)).toBe(false);
  expect(asksFirst({ ...roomTool("agent_create"), write: true }, [], auto)).toBe(false);
  expect(asksFirst(tool("github_comment"), [], auto)).toBe(true);
});
it("runs everything in Bypass but the floor", () => {
  expect(asksFirst(tool("github_comment"), [], bypass)).toBe(false);
  expect(asksFirst(tool("web_fetch"), ["github"], bypass)).toBe(false);
  expect(asksFirst({ ...tool("mcp__test__add_note"), destructive: false }, [], bypass)).toBe(false);
});
it("always asks before a destructive call, and before anything that leaves the room once the thread read room chat", () => {
  for (const rules of [ask, auto, bypass]) {
    expect(asksFirst({ ...tool("mcp__test__add_note"), destructive: true }, [], rules)).toBe(true);
    for (const name of ["web_search", "web_fetch", "github_get", "github_comment", "mcp__test__echo"]) expect(asksFirst(tool(name), ["room"], rules)).toBe(true);
    expect(asksFirst(IMAGE_GATE, ["room"], rules)).toBe(true);
    expect(asksFirst(SANDBOX_GATE, ["room"], { ...rules, sandboxInternet: true })).toBe(true);
    expect(asksFirst(SANDBOX_GATE, ["room"], { ...rules, sandboxInternet: false })).toBe(false);
  }
  expect(asksFirst(tool("web_fetch"), ["room"], bypass)).toBe(true);
});
// mcp/client/remote.test.ts
it("records a tool destructive unless the server marks it destructiveHint: false", () => {
  // listRemoteTools over a fake server: {readOnlyHint:false} → destructive true; {destructiveHint:false} → false
});
// mcp/client/tools.test.ts
it("reads a snapshot without the field as destructive, and a read-only tool never as destructive", () => {
  expect(mcpTool("R", conn, { ...info, readOnly: false }).destructive).toBe(true);
  expect(mcpTool("R", conn, { ...info, readOnly: false, destructive: false }).destructive).toBe(false);
  expect(mcpTool("R", conn, { ...info, readOnly: true }).destructive).toBe(false);
});
// runs/approval.test.ts — roomConnections mock gains approvalMode/postCap/sandboxInternet
it("asks a helper lane's web call in Bypass once the thread read room chat", async () => {
  fake.taint = ["room"];
  const helper = { ...run, model: "claude-sonnet-5-5", agent: { tools: ["web"] }, helper: { lane: 1, step: 2, task: "t", parent: "agent" } } as RoutedRun;
  mode = "bypass";
  expect(await gateOf(helper, { id: "c3", name: "web_fetch", input: { url: "https://example.com/" } }, [])).toMatchObject({ asks: true });
});
it("asks before sandbox code while the sandbox reaches the internet in a thread that read room chat", ...);   // title "Run python in the sandbox with internet access?"
// runs/tool-step.test.ts
it("doesn't run sandbox code a member denied, and leaves the thread's taint alone", ...);   // output "Denied by bea. …", runSandbox not called, addTaint not called
// approvals/repo.test.ts
it("refuses a decision from anyone without a member item, an agent's pseudo-user included", async () => {
  // findMember → undefined for { userId: "agent", username: "scout" }
  await expect(approvalsRepo().decide({ userId: "agent", username: "scout" }, "run1", 1, "approve")).rejects.toThrow("Only members of this room can approve.");
});
// runs/approval.int.test.ts (int, written, run batched)
it("in Bypass a GitHub write runs at once, and after a room read a web search still waits for a member", ...);
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/runs/tools.test.ts src/runs/approval.test.ts src/runs/tool-step.test.ts src/mcp/client src/approvals/repo.test.ts`
Expected: FAIL (`asksFirst` takes two arguments, `SANDBOX_GATE` missing). The approvals test may already pass: keep it as the pin.

- [ ] **Step 3: Implement** the signatures above in the files named. The floor's outbound kinds are a `Set` of `web`, `mcp`, `images`, `github`. Update the loop's doc comment in `loop.ts` to say a call may wait because of the room's mode or the floor.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `feat(runs): approval modes and the hard floor`

---

### Task 4: Room reads without a member: directory, history, search, transcript lines

**Files:**
- Modify: `services/src/rooms/repo.ts`, `services/src/chat/repo.ts`, `services/src/chat/search.ts`, `services/src/chat/model.ts`, `services/src/mcp/server/tools.ts` (uses the moved `transcriptLine`)
- Test: `services/src/chat/model.test.ts`, `services/src/chat/search.test.ts`, `services/src/rooms/repo.int.test.ts` (int, written, run batched)

**Interfaces:**
- Produces:
  - `rooms/repo.ts`: `export async function roomDirectory(roomId: string): Promise<RoomDirectory>` with `RoomDirectory = { room: { roomId: string; name: string }; chats: { chatId: string; name: string; lastSeq: number; archived: boolean }[]; threads: ThreadSummary[]; members: { userId: string; username: string; role: Role }[] }`. It reads the same items `getRoomView` reads, with no member check. `getRoomView` builds its chats, threads and members on it, so the two can't drift.
  - `chatRepo().roomHistory(roomId: string, chatId: string, cursor: Cursor): Promise<{ messages: Message[] }>`, which checks the chat is in the room but not the caller. `history(user, …)` = `requireMember` + `roomHistory`.
  - `chat/search.ts`: `searchMessages(roomId: string, rawQuery: unknown): Promise<{ results: Message[] }>`. `searchRoom(user, …)` = `requireMember` + `searchMessages`.
  - `chat/model.ts`: `transcriptLine(m: Message): string`, moved from the MCP server's private `line`. An agent post reads `[<seq>] <name> (agent) · <at>: <text>`.

- [ ] **Step 1: Write the failing tests**

```ts
// chat/model.test.ts
it("writes one transcript line per message: deleted ones blank, agent posts marked", () => {
  expect(transcriptLine(msg({ seq: 3, authorName: "bea", text: "hi" }))).toBe("[3] bea · 2026-11-13T00:00:00.000Z: hi");
  expect(transcriptLine(msg({ deleted: "self", text: "" }))).toContain(": (deleted)");
  expect(transcriptLine(msg({ authorId: "agent", authorName: "scout", agentPost: { threadId: "T", number: 4 } }))).toContain("scout (agent) ·");
});
// chat/search.test.ts
it("searches a room for its own agents without a member check", async () => {
  // the db fake has no MEMBER# item; searchMessages("r1", "deploy") still returns the match, searchRoom(user, …) is NotFound
});
// rooms/repo.int.test.ts (int, written, run batched)
it("the directory lists chats (archived flagged), threads and members with roles, for no caller", ...);
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/chat src/mcp/server`
Expected: FAIL (`transcriptLine`, `searchMessages` not exported).

- [ ] **Step 3: Implement** with the signatures above. The MCP server's `read_messages` output stays byte-identical for people's messages (its tests pin that).

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `refactor(chat): room reads a run can make without a member`

---

### Task 5: Read room tools

**Files:**
- Create: `services/src/tools/room/read.ts`, `services/src/tools/room/read.test.ts`
- Modify: `services/src/tools/types.ts` (`Tool.kind`, `ToolEnv.room`), `services/src/tools/index.ts`, `services/src/runs/steps.ts` (`toolRoom`), `services/src/runs/tool-step.ts` (`runRoomTool`), `services/src/runs/approval.ts`, `services/src/memory/tools.ts` (unchanged fields, new env shape)
- Test: `services/src/tools/index.test.ts`, `services/src/runs/tools.test.ts`, `services/src/runs/tool-step.test.ts`

**Interfaces:**
- Consumes: `roomDirectory`, `chatRepo().roomHistory`, `searchMessages`, `transcriptLine` (Task 4); `findChat` (`mcp/server/refs.ts`); `ROOM_TAINT`, `privateOf` (Task 1).
- Produces:
  - `Tool.kind = "github" | "mcp" | "memory" | "web" | "room_read" | "room_post" | "room_agents"`.
  - `ToolEnv.room = { roomId: string; threadId: string; threadNumber: number; runId: string; agentId: string; agentName: string; kinds: ToolKind[]; delegates: Delegates; tainted: boolean; postCap: number }`.
  - `toolRoom(run: RoutedRun, opts: { tainted: boolean; postCap: number }): ToolEnv["room"]`. Its two callers pass `isPrivate(seen)` and `room.postCap`.
  - `ROOM_READ_TOOLS: Tool[]` (`kind: "room_read"`, `write: false`, no `ask`):
    - `room_list {}`: per chat `#name` (+ ` · archived`); per thread `#<n> <name> · @<agent> · <status> · <lastActivityAt>` (+ ` · archived`), newest 50.
    - `room_read {chat: string, before?: integer ≥ 1, limit?: integer 1–100 = 30}`: `chat` takes a chat name, `#12`, a thread name or an id (`findChat`). It returns a heading line plus `transcriptLine`s, messages and answers only.
    - `room_search {query: string}`: up to 30 lines `#<chat or thread> · <transcriptLine>`.
    - `room_members {}`: `<username> · <role>` per member.
  - `roomTools(...)` offers `ROOM_READ_TOOLS` only when `privateOk`, as GitHub is. `findTool` finds them always.
  - `runRoomTool` adds `ROOM_TAINT` to the thread before running any `room_read` tool. `room_read` and `room_search` also add `privateOf` of every thread they return content from, before returning.

- [ ] **Step 1: Write the failing tests**

```ts
// tools/room/read.test.ts (roomDirectory / roomHistory / searchMessages / threadsRepo().addTaint mocked)
it("lists chats and threads with numbers, agents and status, archived ones flagged", async () => {
  const out = (await tool("room_list").run({}, env)).output;
  expect(out).toContain("#general");
  expect(out).toContain("#old · archived");
  expect(out).toMatch(/#4 pr-check · @reviewer · done · /);
});
it("reads a thread by #number or a chat by name, deleted messages blank, and never the thread's step logs", ...);
it("copies a private thread's taint into the reading thread, and never the room taint alone", async () => {
  await tool("room_read").run({ chat: "#4" }, env);   // thread 4 has taint ["github", "room"]
  expect(added).toEqual([["R", 7, ["github"]]]);
});
it("copies the taint of every private thread a search result came from", ...);
it("names an unknown chat with the room's chats", async () => {
  expect((await tool("room_read").run({ chat: "nope" }, env))).toEqual({ ok: false, output: expect.stringContaining('No chat or thread "nope"') });
});
it("lists members with their roles, so the agent can @mention people", ...);
// tools/index.test.ts
it("offers the read room tools only to a model that may see private content", () => {
  expect(roomTools({ roomId: "R", mcp: [], github: false, privateOk: false }).map((t) => t.spec.name)).not.toContain("room_read");
  expect(roomTools({ roomId: "R", mcp: [], github: false, privateOk: true }).map((t) => t.spec.name)).toContain("room_read");
});
// runs/tools.test.ts
it("offers room_* tools only to an agent with that kind", () => {
  expect(toolsFor("claude-sonnet-5-5", "anthropic", room, ["web"]).map((t) => t.name)).not.toContain("room_list");
  expect(toolsFor("claude-sonnet-5-5", "anthropic", room, ["room_read"]).map((t) => t.name)).toEqual(expect.arrayContaining(["room_list", "room_read", "room_search", "room_members"]));
});
// runs/tool-step.test.ts
it("marks the thread as holding room data before a read's result is logged", ...);   // addTaint(["room"]) before step.finished
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/tools src/runs/tools.test.ts src/runs/tool-step.test.ts`
Expected: FAIL (module `tools/room/read.ts` missing).

- [ ] **Step 3: Implement** `ROOM_READ_TOOLS` in `tools/room/read.ts` and the env/registry changes above. A `UserError` from a repo (NotFound, ValidationError) comes back as `{ ok: false, output: e.message }`. Anything else throws, so the step fails and is retried.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `feat(tools): agents read their room`

---

### Task 6: `room_post`

**Files:**
- Create: `services/src/tools/room/post.ts`, `services/src/tools/room/post.test.ts`
- Modify: `services/src/tools/types.ts` (`check` may be async), `services/src/runs/approval.ts` and `services/src/runs/tool-step.ts` (`await tool.check?.(…)`; `unsure("the chat")` for `room_post`), `services/src/chat/repo.ts` (`send` opts), `services/src/tools/index.ts`
- Test: `services/src/chat/repo.test.ts`, `services/src/runs/tool-step.test.ts`, `services/src/runs/approval.int.test.ts` (int, written, run batched)

**Interfaces:**
- Consumes: `roomDirectory` (Task 4), `ToolEnv.room` (Task 5), `mentionedAgents` (`agents/model.ts`), `tagNumbers`/`tagNames` (`threads/route.ts`), `parseMentions` (`chat/mentions.ts`), `messageText` (`chat/model.ts`), `broadcastToRoom`.
- Produces:
  - `Tool.check?(input, env): string | null | Promise<string | null>`.
  - `chatRepo().send(user, input, admitted, opts: { copy?: boolean; system?: boolean; agentPost?: Message["agentPost"] })`, which stores `agentPost` on the message.
  - `tools/room/post.ts`:
    - `postRefusal(text: string, room: { agents: Pick<Agent, "name">[]; threads: Pick<ThreadSummary, "number" | "name">[] }): string | null`. It refuses `@everyone` (via `parseMentions(...).everyone`), the first agent `mentionedAgents` finds, and the first `#tag` (`tagNumbers`/`tagNames`) that is a thread's number or name.
    - `postsMade(events: RunEvent[]): number`: `room_post` steps whose `step.finished` is `ok`, any lane.
    - `ROOM_POST: Tool` = `room_post {chat: string, text: string}`, `kind: "room_post"`, `write: true`. Its async `check` refuses, in this order: no text (`A post needs text.`), over 4,000 characters, the cap (`postsMade(await runsRepo().allEvents(env.room.runId)) >= env.room.postCap`), an unknown or thread chat, an archived chat, then `postRefusal`. `ask` gives the title from Global Constraints. `run` re-runs `check`, then `chatRepo().send({ userId: "agent", username: env.room.agentName }, { roomId, chatId, clientId: \`${runId}#post\`, text }, { text, attachments: [] }, { system: true, agentPost: { threadId, number: threadNumber } })`, broadcasts `message.new` (best effort) and returns `Posted in #<chat> (message <seq>).`
  - Offered to every model (it returns no room content), as `room_post` kind.

- [ ] **Step 1: Write the failing tests**

```ts
// tools/room/post.test.ts
const room = { agents: [{ name: "agent" }, { name: "reviewer" }], threads: [{ number: 12, name: "pr-check" }] };
it("refuses a post that would reach an agent or a thread, or the whole room", () => {
  expect(postRefusal("hey @everyone", room)).toBe("Posts can't use @everyone.");
  expect(postRefusal("@reviewer can you look", room)).toBe("Posts can't mention agents (@reviewer). Hand work to an agent with delegate.");
  expect(postRefusal("see #12", room)).toBe("Posts can't tag threads (#12). Name the thread without the #.");
  expect(postRefusal("see #pr-check", room)).toBe("Posts can't tag threads (#pr-check). Name the thread without the #.");
});
it("lets people, chats and code through", () => {
  expect(postRefusal("@bea done, see #general and `@reviewer`", room)).toBeNull();
  expect(postRefusal("see #13", room)).toBeNull();   // no such thread: only text
});
it("counts only posts that went out, in every lane", () => {
  expect(postsMade([started(1, "room_post"), finished(1, true), started(2, "room_post"), finished(2, false), started(3, "room_post", 1), finished(3, true, 1), started(4, "web_fetch"), finished(4, true)])).toBe(2);
});
it("refuses the post past the room's cap before anyone is asked", async () => {
  // 10 ok room_post steps in the run's events, env.room.postCap 10
  expect(await ROOM_POST.check!({ chat: "general", text: "hi" }, env)).toBe("This run has made its 10 posts, the room's cap per run.");
});
it("refuses a thread, an unknown chat and an archived one", async () => {
  expect(await ROOM_POST.check!({ chat: "nope", text: "hi" }, env)).toBe("There's no chat #nope here. Chats: #general, #old.");
  expect(await ROOM_POST.check!({ chat: "old", text: "hi" }, env)).toBe("#old is archived.");
  expect(await ROOM_POST.check!({ chat: "pr-check", text: "hi" }, env)).toMatch(/^There's no chat #pr-check here/);
});
it("posts as the agent, marked as an agent post from its thread, and never routes", async () => {
  const result = await ROOM_POST.run({ chat: "general", text: "Deploy done, @bea" }, env);
  expect(result).toEqual({ ok: true, output: "Posted in #general (message 8)." });
  expect(sent).toEqual([[{ userId: "agent", username: "scout" }, expect.objectContaining({ chatId: "C1", text: "Deploy done, @bea" }), { text: "Deploy done, @bea", attachments: [] },
    { system: true, agentPost: { threadId: "T", number: 7 } }]]);
  expect(startOrSteer).not.toHaveBeenCalled();   // vi.mock("../../runs/start.js") spy
});
it("asks with the chat and the start of the text", () => {
  expect(ROOM_POST.ask!({ chat: "general", text: "x".repeat(100) }, env)).toBe(`Post in #general: "${"x".repeat(80)}"?`);
});
// chat/repo.test.ts
it("stores an agent post's thread link, moves no read marker, and notifies the people it names", ...);   // Put Item.agentPost; no READ# update; pushed[0].userIds = [bea's id]
// runs/tool-step.test.ts
it("never posts twice: a post step found already started tells the model to check the chat", ...);   // output unsure("the chat")
// runs/approval.int.test.ts (int, written, run batched)
it("in Ask a post waits for a member, in Auto it posts at once, and the channel gets it as the agent's", ...);
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/tools/room src/chat/repo.test.ts src/runs/tool-step.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** with the signatures above.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `feat(tools): agents post in channels as themselves`

---

### Task 7: Agent posts in the channel UI

**Files:**
- Modify: `web/components/chat/MessageRow.tsx`
- Test: `web/components/chat/MessageRow.test.tsx`

**Interfaces:**
- Consumes: web `Message.agentPost` (Task 1); `useThreads().byId` (already in the file); `AgentAvatar`, `AiTag`.
- Produces: `automated = m.authorId === "schedule" || !!m.agentPost`. An agent post shows the agent tile, the agent's own name (`m.authorName`) in lime, `AiTag`, and a link `from #<thread name>` (`byId(threadId)?.name`, else `#<number>`) to `/r/<roomId>/t/<number>`. Like schedule cards, it has no edit action.

- [ ] **Step 1: Write the failing test**

```tsx
it("shows an agent's post with its tile, its own name, the AI tag and a link to the thread it came from", () => {
  renderRow({ authorId: "agent", authorName: "scout", text: "Deploy done", agentPost: { threadId: "T4", number: 4 } }, { threads: [thread({ threadId: "T4", number: 4, name: "release" })] });
  expect(screen.getByText("scout")).toBeInTheDocument();
  expect(screen.getByText("AI")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "from #release" })).toHaveAttribute("href", "/r/R/t/4");
  expect(screen.queryByLabelText("scout's avatar")).toBeNull();   // people's round avatar is never used
});
it("links by number when the thread isn't loaded", ...);   // "from #4"
```

- [ ] **Step 2: Run to verify it fails**
Run: `npm -w web run test -- components/chat/MessageRow.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** in `MessageRow.tsx`. Check the link fits on one line at 390 px: it truncates after the name, never wraps the header.

- [ ] **Step 4: Run to verify it passes**, then `npm run check`

- [ ] **Step 5: Commit** `feat(web): agent posts read as the agent's, linked to their thread`

---

### Task 8: Agents create and edit agents (`room_agents`)

**Files:**
- Create: `services/src/tools/room/agents.ts`, `services/src/tools/room/agents.test.ts`
- Modify: `services/src/agents/model.ts`, `services/src/agents/repo.ts`, `services/src/approvals/repo.ts` (`decide` stores `byId`), `services/src/tools/types.ts` (`ToolEnv.approver`), `services/src/runs/tool-step.ts` (sets `approver` from an approved `settled`), `services/src/tools/index.ts`
- Test: `services/src/agents/model.test.ts`, `services/src/approvals/repo.test.ts`, `services/src/agents/repo.int.test.ts` (int, written, run batched)

**Interfaces:**
- Consumes: `Delegates`, `Agent.madeBy` (Task 1); `ToolEnv.room.agentId/kinds/delegates` (Task 5); async `check` (Task 6); `agentName`, `instructionsText`, `toolKinds`, `agentModel`, `requireOffered`.
- Produces:
  - `Approval += { byId?: string }`, written with `by` in `decide`.
  - `ToolEnv += { approver?: User }`, set only for an approved call.
  - `agents/model.ts`:
    - `delegatesTo(agent: Pick<Agent, "delegates">, agentId: string): boolean`.
    - `grantRefusal(creator: { name: string; tools: ToolKind[]; delegates: Delegates }, asked: { tools: ToolKind[]; delegates: Delegates }, names: (agentId: string) => string): string | null`. A child `"all"` needs a parent `"all"`. Otherwise every child id must be one the parent delegates to.
    - `canAgentEdit(target: Agent, agentId: string): boolean`: true only for a non-built-in, non-deleted target with `madeBy?.agentId === agentId` and `target.agentId !== agentId`.
  - `agentsRepo()`:
    - `createByAgent(roomId: string, input: AgentInput, madeBy: { agentId: string; name: string }, approver?: User): Promise<Agent>`. It shares `claim` and the username check with `create`. It sets `createdBy`/`createdByName` to the approver's or `""`, and `madeBy`.
    - `updateByAgent(roomId: string, agentId: string, patch: Partial<AgentInput>, by: string): Promise<Agent>`. It refuses with `canAgentEdit` and shares the conditional write and rename transaction with `update`.
    - `AgentInput += { delegates?: Delegates }`.
  - `tools/room/agents.ts`: `AGENT_TOOLS: Tool[]`, kind `room_agents`, `write: true`, offered to every model.
    - `agent_create {name, instructions?, tools: string[], model?: string, delegates?: string[] (agent names)}`
    - `agent_edit {agent: string, name?, instructions?, tools?, model?, delegates?}`
    - Delegate names map to ids through `agentsRepo().list`. Unknown names are refused with `There's no @<x> in this room.` Omitted `delegates` on create = the creator's list.
    - `check` runs the validators (a thrown `ValidationError`'s message is the refusal), `requireOffered`, `grantRefusal` against `env.room` (the creator's kinds and delegates *now*), and for edit `canAgentEdit`. The model is free.
    - `ask` and the results use the copy in Global Constraints.

- [ ] **Step 1: Write the failing tests**

```ts
// agents/model.test.ts
const scout = { name: "scout", tools: ["web", "room_post"] as ToolKind[], delegates: ["A1"] as Delegates };
const named = (id: string) => ({ A1: "reviewer", A2: "writer" })[id] ?? id;
it("lets an agent grant only what it has", () => {
  expect(grantRefusal(scout, { tools: ["web"], delegates: ["A1"] }, named)).toBeNull();
  expect(grantRefusal(scout, { tools: ["web", "github", "room_agents"], delegates: ["A1", "A2"] }, named))
    .toBe("@scout can't give what it doesn't have: github, room_agents, @writer. Ask a member to add it by hand.");
  expect(grantRefusal(scout, { tools: [], delegates: "all" }, named)).toMatch(/can't give what it doesn't have: any agent/);
  expect(grantRefusal({ ...scout, delegates: "all" }, { tools: [], delegates: "all" }, named)).toBeNull();
});
it("lets an agent edit only agents it made, never itself, a person's or the built-in", () => {
  expect(canAgentEdit(agent({ agentId: "B", madeBy: { agentId: "S", name: "scout" } }), "S")).toBe(true);
  expect(canAgentEdit(agent({ agentId: "B" }), "S")).toBe(false);
  expect(canAgentEdit(agent({ agentId: "B", madeBy: { agentId: "X", name: "other" } }), "S")).toBe(false);
  expect(canAgentEdit({ ...BUILT_IN }, "S")).toBe(false);
});
it("delegates to all by default and to the listed agents otherwise", () => {
  expect(delegatesTo({}, "A2")).toBe(true);
  expect(delegatesTo({ delegates: ["A1"] }, "A2")).toBe(false);
});
// approvals/repo.test.ts
it("stores who approved by id as well as name", ...);   // UpdateCommand values include ":byId": "u-bea"
// tools/room/agents.test.ts
it("creates an agent no stronger than its creator, made by the agent and owned by who approved it", async () => {
  await AGENT_TOOLS[0].run({ name: "helper", tools: ["web"] }, { ...env, approver: { userId: "u-bea", username: "bea" } });
  expect(createByAgent).toHaveBeenCalledWith("R", expect.objectContaining({ name: "helper", tools: ["web"], delegates: ["A1"] }), { agentId: "S", name: "scout" }, { userId: "u-bea", username: "bea" });
});
it("refuses a kind the creator lacks before anyone is asked", async () => {
  expect(await AGENT_TOOLS[0].check!({ name: "helper", tools: ["github"] }, env)).toBe("@scout can't give what it doesn't have: github. Ask a member to add it by hand.");
});
it("refuses to edit an agent it didn't make", async () => {
  expect(await tool("agent_edit").check!({ agent: "reviewer", instructions: "x" }, env)).toBe("@scout can edit only the agents it created, never itself.");
});
it("asks with the new agent's name and kinds", () => {
  expect(tool("agent_create").ask!({ name: "helper", tools: ["web", "room_read"] }, env)).toBe("Create @helper (web, room_read)?");
  expect(tool("agent_create").ask!({ name: "helper", tools: [] }, env)).toBe("Create @helper (no tools)?");
});
// agents/repo.int.test.ts (int, written, run batched)
it("an agent-made agent records its maker; the approving member edits and deletes it as its creator; in Auto it has no approver and only admins and its maker change it", ...);
it("updateByAgent refuses another agent's, a person's and the agent's own record", ...);
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/agents src/approvals src/tools/room`
Expected: FAIL.

- [ ] **Step 3: Implement** with the signatures above. Keep `create`/`update` behaviour identical for people. Factor the shared write into private functions inside `agentsRepo` (no new export). The edit bound is computed at edit time from `env.room.kinds`, so an agent that lost a kind can't hand it on later.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `feat(tools): agents create and edit the agents they made`

---

### Task 9: Delegate allowlist, room kinds and "made by" in the agent form

**Files:**
- Modify: `services/src/agents/model.ts` (`delegateList`), `services/src/agents/handler.ts`, `services/src/runs/steps.ts` (`load`)
- Modify: `web/components/rooms/AgentForm.tsx`, `web/components/rooms/AgentsPanel.tsx`, `web/lib/client/agents.ts`
- Test: `services/src/agents/model.test.ts`, `services/src/agents/handler.test.ts`, `services/src/runs/steps.test.ts` (new, a `load` unit test), `web/components/rooms/AgentsPanel.test.tsx`, `web/lib/client/agents.test.ts`

**Interfaces:**
- Consumes: `delegatesTo`, `Delegates`, `Agent.madeBy` (Tasks 1, 8).
- Produces:
  - `delegateList(raw: unknown): Delegates`: `"all"`, or an array of at most 21 distinct agent-id strings (`/^[A-Za-z0-9_-]{1,64}$/`), else `ValidationError('Delegates are "all" or a list of agent ids.')`. POST and PATCH `/agents` accept `delegates`.
  - `load()`: `others = all.filter((a) => a.agentId !== agent.agentId && delegatesTo(agent, a.agentId))`.
  - web `AgentInput += { delegates: Delegates }`. `TOOL_KINDS` gains `room_read` "Read room" (`BookOpen`), `room_post` "Post in channels" (`Megaphone`), `room_agents` "Manage agents" (`Bot`). A new agent starts with `kinds.filter((k) => !ROOM_KINDS.includes(k))`, where web `ROOM_KINDS` lives in `lib/client/agents.ts`.
  - `AgentForm` prop `others: Agent[]`: a "Hands work to" fieldset with an "Any agent" checkbox (`"all"`), and when that is unticked, one checkbox per other agent.
  - `madeByLine(a: Agent): string` in `lib/client/agents.ts`: `built in` · `by <createdByName>` · `by @<madeBy.name>` · `by @<madeBy.name> · approved by <createdByName>`. AgentsPanel uses it.

- [ ] **Step 1: Write the failing tests**

```ts
// agents/model.test.ts
it("takes all or a list of agent ids for delegates", () => {
  expect(delegateList("all")).toBe("all");
  expect(delegateList(["a1", "a1", "b2"])).toEqual(["a1", "b2"]);
  expect(() => delegateList("some")).toThrow('Delegates are "all" or a list of agent ids.');
});
// runs/steps.test.ts
it("offers a run only the agents its agent may delegate to", async () => {
  // agentsRepo mocked: agent { delegates: ["A1"] }, list [built-in, A1, A2]
  expect((await load("RUN"))!.others.map((o) => o.agentId)).toEqual(["A1"]);
});
// web lib/client/agents.test.ts
it("says who made an agent, and who approved one an agent made", () => {
  expect(madeByLine(agent({ madeBy: { agentId: "S", name: "scout" }, createdByName: "bea" }))).toBe("by @scout · approved by bea");
  expect(madeByLine(agent({ madeBy: { agentId: "S", name: "scout" }, createdByName: "" }))).toBe("by @scout");
});
// web AgentsPanel.test.tsx
it("starts a new agent with the room tools off, and sends a narrowed delegate list", async () => {
  // open New agent: #agent-new-room_read / room_post / room_agents unchecked, #agent-new-web checked
  // untick "Any agent", tick @reviewer → POST body delegates: ["<reviewer id>"]
});
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/agents src/runs/steps.test.ts` and `npm -w web run test -- components/rooms lib/client/agents.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** with the signatures above. The form fits 390 px: the delegate list wraps as rows of checkboxes, with no horizontal scroll.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `feat(agents): a delegate allowlist and the room tools in the agent form`

---

### Task 10: Connectors: refuse chat-lite's own `/mcp`, and the Linear/Notion catalog

**Files:**
- Modify: `services/src/mcp/client/url.ts`, `infra/lib/mcp-connections.ts`, `web/lib/client/mcp.ts`, `web/components/rooms/McpServers.tsx`
- Test: `services/src/mcp/client/url.test.ts`, `infra/lib/mcp-connections.test.ts`, `web/components/rooms/McpServers.test.tsx`

**Interfaces:**
- Produces:
  - `ownMcpUrls(env: Record<string, string | undefined> = process.env): string[]`: for each of `SITE_ORIGINS` (comma list) and `MCP_BASE_URL`, `<base without trailing slashes>/mcp`.
  - `mcpServerUrl(raw: unknown, localHosts: string[], own: string[] = ownMcpUrls()): URL`. It throws `ValidationError(<self-MCP copy>)` when `url.origin + url.pathname` (trailing slashes stripped) equals one of `own` after `new URL()` normalization. Query and hash are ignored.
  - The mcp-connections Lambda environment gains `MCP_BASE_URL: stack.publicApiUrl`.
  - web `MCP_CATALOG: { name: string; label: string; url: string }[]` = Linear `linear` `https://mcp.linear.app/mcp`, Notion `notion` `https://mcp.notion.com/mcp`. For admins, `McpServers` shows a "Connect Linear" / "Connect Notion" button for each entry whose URL no server of the room has. The button calls the existing `add(name, url)`, which is the same OAuth flow as the form.

- [ ] **Step 1: Write the failing tests**

```ts
// mcp/client/url.test.ts
const own = ownMcpUrls({ SITE_ORIGINS: "https://chat.amanarya.com,http://localhost:3000", MCP_BASE_URL: "http://api.local:4566/" });
it("refuses chat-lite's own MCP server on any site origin or the MCP base, however it's written", () => {
  for (const raw of ["https://chat.amanarya.com/mcp", "https://CHAT.amanarya.com/mcp/", "https://chat.amanarya.com/mcp?x=1", "http://localhost:3000/mcp", "http://api.local:4566/mcp"]) {
    expect(() => mcpServerUrl(raw, ["localhost", "api.local"], own)).toThrow("That's chat-lite's own MCP server.");
  }
});
it("allows other paths on those hosts, and other servers", () => {
  expect(mcpServerUrl("https://chat.amanarya.com/other/mcp", [], own).href).toBe("https://chat.amanarya.com/other/mcp");
  expect(mcpServerUrl("https://mcp.linear.app/mcp", [], own).hostname).toBe("mcp.linear.app");
});
// infra/lib/mcp-connections.test.ts: Environment.Variables toMatchObject({ MCP_BASE_URL: expect.anything() })
// web McpServers.test.tsx
it("offers one-click Linear and Notion to admins, and connects through the usual flow", async () => {
  // click "Connect Linear" → bff POST /connections/mcp with { name: "linear", url: "https://mcp.linear.app/mcp", redirectUri }
});
it("hides a catalog entry the room already has, and the whole catalog from members", ...);
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w services run test -- src/mcp/client/url.test.ts`, `npm -w infra run test -- lib/mcp-connections.test.ts`, `npm -w web run test -- components/rooms/McpServers.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** with the signatures above.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `feat(mcp): refuse chat-lite's own server; one-click Linear and Notion`

---

### Task 11: Settings UI and the mode badge

**Files:**
- Modify: `web/components/rooms/RoomSettings.tsx`, `web/components/rooms/ConnectionsPanel.tsx`, `web/components/shell/Header.tsx`, `web/components/shell/RoomShell.tsx`, `web/components/rooms/ActivityLog.tsx` (`ICONS` for `mode`, `cap`)
- Test: `web/components/rooms/ConnectionsPanel.test.tsx`, `web/components/shell/Header.test.tsx`

**Interfaces:**
- Consumes: GET connections `approvalMode`, `postCap`; the PUT routes (Task 2); `RoomView.approvalMode` (Task 2).
- Produces:
  - `RoomSettings` props gain `approvalMode?: ApprovalMode; postCap?: number; onModeChange; onCapChange`. Two rows join the timeout row:
    - "Agent approvals": a segmented Ask / Auto / Bypass control, editable by admins and read-only for members, with a `?` hint that states each mode in one line.
    - "Agents post up to `<n>` times a run": a pencil-to-edit field like the timeout, `aria-label="Post cap per run, 1 to 50"`.
  - `Header` prop `approvalMode?: ApprovalMode`. In Auto or Bypass it shows a small quiet pill (`Auto` / `Bypass`, `role="img"`, the title copy from Global Constraints) next to the chat or thread title. Nothing shows in Ask. RoomShell passes `view.approvalMode`, which refetches on `room.updated` as the rest of the view does.

- [ ] **Step 1: Write the failing tests**

```tsx
// Header.test.tsx
it("shows the room's mode beside the title in Auto and Bypass only", () => {
  const { rerender } = render(<Header {...props} approvalMode="auto" />);
  expect(screen.getByRole("img", { name: "Auto: agents post and set up agents without asking." })).toHaveTextContent("Auto");
  rerender(<Header {...props} approvalMode="ask" />);
  expect(screen.queryByText("Auto")).toBeNull();
});
it("shows no lock for a thread that only read room chat", () => {
  render(<Header {...props} taint={["room"]} />);
  expect(screen.queryByRole("img", { name: /Private/ })).toBeNull();
});
// ConnectionsPanel.test.tsx
it("lets an admin switch the mode and set the post cap; a member only reads them", async () => {
  // admin: click "Bypass" → PUT /approval-mode {mode:"bypass"}; edit cap → PUT /post-cap {cap: 25}, row reads "Agents post up to 25 times a run"
  // member: no buttons enabled, no pencil
});
```

- [ ] **Step 2: Run to verify they fail**
Run: `npm -w web run test -- components/shell/Header.test.tsx components/rooms/ConnectionsPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.** Check at 390 px that the badge never pushes the panel button off the header: the title truncates first.

- [ ] **Step 4: Run to verify they pass**, then `npm run check`

- [ ] **Step 5: Commit** `feat(web): approval mode and post cap settings, and the mode badge`

---

### Task 12: The agent brief, the smoke check and the learn note

**Files:**
- Modify: `services/src/runs/prompt.ts`, `scripts/src/smoke-agents.ts`
- Create: `docs/learn/15-room-agent-powers.md` (the pattern every step follows: what was built, the patterns worth explaining, what to try)
- Test: `services/src/runs/prompt.test.ts`

**Interfaces:**
- Produces:
  - In `AGENT_BRIEF`, the sentence `"GitHub writes, MCP tools not marked read-only, and web calls or images in a thread with private content, wait for a room member's approval. "` is replaced, verbatim, by:
    `"Some tool calls wait for a room member's approval, as the room's settings decide; a denied call stays denied. "`
    `+ "The room tools act only in this room: room_list, room_read, room_search and room_members read it; room_post posts in a channel as you; agent_create and agent_edit set up agents you make. "`
    `+ "A post never mentions an agent, tags a thread or uses @everyone: reach another agent only with delegate. "`
  - Smoke: one block in `agentChecks`, with two checks.
    1. A creates `@herald` through the BFF (`tools: ["room_post"]`) and a chat `fake`, then sets the mode with `PUT /bff/api/rooms/<id>/approval-mode {mode:"auto"}`. B's header shows the `Auto` badge within 10 s, with no reload.
    2. A asks `@herald call:room_post`. The thread ends `done` without any `approval.requested`. The last message of `#fake` has `authorId: "agent"`, `authorName: "herald"`, `agentPost.number` = the thread's number and text `fake`. B's `#fake` view shows that row with the `AI` tag and the link `from #<thread name>`. Afterwards the mode goes back to `ask`.

- [ ] **Step 1: Write the failing test**

```ts
it("tells every agent what the room tools are, and that posts never reach agents or threads", () => {
  expect(text).toContain("Some tool calls wait for a room member's approval, as the room's settings decide; a denied call stays denied.");
  expect(text).toContain("A post never mentions an agent, tags a thread or uses @everyone: reach another agent only with delegate.");
  expect(text).not.toContain("GitHub writes, MCP tools not marked read-only");
});
```

- [ ] **Step 2: Run to verify it fails**
Run: `npm -w services run test -- src/runs/prompt.test.ts`
Expected: FAIL. Replace the old pinned sentence in that test file with the new one.

- [ ] **Step 3: Implement** the brief and the smoke block. Keep the smoke block to those two `check(...)` calls. Write the learn note, covering at least: the floor as a taint-driven deny rule, why posts bypass routing, and least privilege for agent-made agents.

- [ ] **Step 4: Run to verify it passes**, then `npm run check`. Don't run the smoke: the controller runs it with the batched int suite after a Floci reset (`npm run smoke`, expect every check `ok`).

- [ ] **Step 5: Commit** `feat(agents): the brief knows the room tools; smoke covers Auto and agent posts`
