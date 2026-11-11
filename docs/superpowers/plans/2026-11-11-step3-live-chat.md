# Step 3: Live People Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Room members chat live in people chats, with the G2 UI and motion. They get:
- messages pushed over a WebSocket, plus presence ("online / last seen") and typing;
- automatic reconnect that fills the gap;
- reactions, quote-replies, light markdown and @mentions (including @everyone);
- edit and delete within 15 minutes, with history kept, and admin removal;
- attachments up to 10 MB;
- unread and mention badges, mute and keyword search;
- leave room and archive room;
- a soft sound on @mention;
- a layout that works at phone width.

**Architecture:**
- **WebSocket API:** an API Gateway WebSocket API (route selection on `$request.body.action`) in front of one `live` Lambda.
- **Auth:** the browser gets a **one-time, 60-second ticket** from the HTTP API (through the BFF, so the ID token never reaches page JS) and connects with `?ticket=`.
- **Sending:** sends and edits go over the socket and each one is **acknowledged** to the sender. History, search and attachment uploads use the HTTP API, through a new `chat` Lambda.
- **Storage:** messages live in a per-chat partition, ordered by a per-chat **sequence number** that an atomic counter allocates.
- **Fan-out:** events go to the room's subscribed connections, filtered to *current* members.
- **Attachments:** files go straight from the browser to S3 with a **presigned POST** (size-limited by the policy).

**Tech Stack:** what step 2 uses, plus:
- `@aws-sdk/client-apigatewaymanagementapi`, `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner` (services);
- `react-markdown` (web; no raw HTML), `ws` (smoke and int tests only).

**Spec:** `docs/superpowers/specs/2026-11-10-chat-lite-design.md`. Read "Decisions for steps 3–11", step 3 under "Proposed steps", "Architecture", "UI and motion" and "Budgets and limits" (rate limits).

## Global Constraints

- **Everything from steps 1–2 still applies:**
  - `cl-<stage>-` names, chat-lite's own Floci, and no VPC/NAT/RDS;
  - the secret scan before each commit and the commit trailer;
  - CLAUDE.md's code rules (least code, why-comments only, no build-process references, interview-worthy patterns);
  - TDD.
- **Values from the spec, verbatim:**
  - **Edit and delete:** within **15 minutes** of sending, own messages only. Owners and admins can remove anyone's message **any time**.
  - **Nothing is truly deleted:** a delete sets `deleted` and blanks `text` in what readers get. The original text and every earlier version stay in DynamoDB.
  - **What the UI shows:** "Message deleted", or "Removed by an admin". Edited messages show "(edited)" only; no history UI.
  - **Reactions:** exactly 👍 ❤️ 😂 🎉 👀 ✅, stored as the keys `thumbs heart joy tada eyes check`.
  - **Attachments:** any file up to **10 MB** (10,485,760 bytes). Images preview inline; other files show as a download chip.
  - **Rate limit:** **30 messages per user per minute.**
  - **Presence:** a static online dot or "last seen …". No pulsing dots anywhere, typing included.
  - **@everyone:** anyone may use it.
  - **Quote-replies:** no sub-threads. No link previews, no read receipts, no DMs.
  - **Formatting:** light markdown only: **bold**, *italic*, `code`, code blocks, http(s) links, @mentions, #tags. Headings, lists, tables, images and raw HTML render as plain text.
  - **Leave:** any member except the owner can leave.
  - **Archive:** the owner can archive a room, which makes it read-only and hides it from the list. Nothing is deleted.
  - **Mute:** a muted chat shows no unread badge, but mention badges still show.
  - **Sound:** a soft sound on @mention while the tab is open; no other sounds.
  - **Look:** dark only, initials avatars, phone width supported.
- **My calls (rulings; record them in the learn doc):**
  - message text ≤ **4,000** characters;
  - ≤ **5** attachments per message;
  - history pages of **50**;
  - search: query ≥ **2** characters, **30** results max, scanning at most the latest **2,000** messages per chat;
  - ticket TTL **60 s**;
  - heartbeat `ping` every **4 min** (API Gateway drops idle sockets at 10 min);
  - reconnect backoff `min(30 s, 1 s × 2^attempt)` with ±20 % jitter;
  - ack timeout **10 s**;
  - typing sent at most every **3 s** and shown for **5 s**;
  - WebSocket stage name `live`.
- **Motion:** spec table plus these:
  - **New message:** opacity 0→1 and y 6→0 px, 200 ms ease-out.
  - **Your own pending message:** shows at once at 60 % opacity, then 100 % on ack.
  - **Reaction chip:** pops with `spring.pop`.
  - **Jump-to-message:** a brief lime row flash.
  - **Badge count change:** a scale pop.
  - **Reduced motion:** every one of these is instant.
  - Only transform and opacity animate.
- **Shared contract:** `Message` and the socket protocol below are defined once in `services/src/chat/model.ts` and mirrored in `web/lib/types.ts`. Keep both in step; the smoke test catches drift.

### The socket protocol (pinned; every task uses these exact shapes)
```ts
type Reaction = "thumbs" | "heart" | "joy" | "tada" | "eyes" | "check";
type Attachment = { key: string; name: string; size: number; type: string; url?: string }; // url: presigned GET, set on reads
type Message = {
  roomId: string; chatId: string; seq: number; authorId: string; authorName: string; clientId?: string;
  text: string;                 // "" when deleted
  createdAt: string; editedAt?: string; deleted?: "self" | "admin";
  replyTo?: { seq: number; authorName: string; excerpt: string };   // excerpt ≤ 140 chars
  attachments: Attachment[]; reactions: Partial<Record<Reaction, string[]>>; // userIds per reaction
  mentions: string[]; everyone: boolean;
};
// client → server, every frame: { action, requestId, ...args }
//   send   {roomId, chatId, clientId, text, replyToSeq?, attachments?: {key,name,size,type}[]}
//   edit   {roomId, chatId, seq, text}        delete {roomId, chatId, seq}
//   react  {roomId, chatId, seq, reaction: Reaction, on: boolean}
//   typing {roomId, chatId}   read {roomId, chatId, seq}   subscribe {}   ping {}
// server → client:
//   {type:"ack", requestId, ok:true, data?} | {type:"ack", requestId, ok:false, error: string}
//   {type:"message.new" | "message.updated", message: Message}
//   {type:"typing", roomId, chatId, userId, username}
//   {type:"presence", userId, online: boolean, lastSeen: string}
//   {type:"read", roomId, chatId, lastReadSeq: number}    // to the reader's other tabs
//   {type:"room.updated", roomId}                         // members/chats/archive changed: refetch the room view
//   {type:"pong"}
```

### Table items added (single table `cl-<stage>-main`)
| Item | pk | sk | Notes |
|---|---|---|---|
| Chat counter | `CHAT#<chatId>` | `META` | `{roomId, lastSeq}`. Created with the chat; `ADD lastSeq 1` with `roomId = :r` allocates the seq **and** proves the chat is in the room. |
| Message | `CHAT#<chatId>` | `MSG#<seq, 10-digit zero-padded>` | the `Message` fields + `textLower`; deleted messages keep `text` in storage, and reads blank it |
| Earlier version | `CHAT#<chatId>` | `VER#<seq padded>#<editedAt ISO>` | `{text}`, written on every edit, never read by the API |
| Read state | `ROOM#<roomId>` | `READ#<userId>#<chatId>` | `{lastReadSeq, mentions, muted}` |
| Member (existing) | `ROOM#<roomId>` | `MEMBER#<userId>` | + `mentions` (room total, for the switcher dot) and `archived` |
| Ticket | `WSTICKET#<ticket>` | `META` | `{userId, username, expiresAt, ttl}`; consumed by a conditional delete |
| Connection | `CONN#<connId>` | `META` | `{userId, username, ttl: now+3h}` |
| User's sockets | `USER#<userId>` | `CONN#<connId>` | for presence |
| Room subscription | `ROOM#<roomId>` | `CONN#<connId>` | `{userId, ttl}`, written for each of the user's rooms on connect/subscribe |
| Presence | `USER#<userId>` | `PRESENCE` | `{conns, lastPing, lastSeen}`. Online = `conns > 0 && lastPing > now − 11 min`, which heals counter drift from sockets that died without `$disconnect` |
| Rate window | `RATE#<userId>` | `<epoch minute>` | `ADD n 1`, ttl +2 min; reject when n > 30 (a fixed-window counter) |

## Review Focus
1. **A removed (or departed) member keeps a live socket:** they must stop receiving that room's events and be refused on `send`/`react`/`typing`. Fan-out filters subscriptions by current members, and every action checks membership. Pinned in Task 3's int tests and Task 8's smoke.
2. **Reconnect gap:** messages sent while a client was offline appear after it reconnects (it fetches `after=<last seq it has>` per open chat). Pinned in the smoke: the socket is force-closed, the other user sends, the socket reconnects, and the message shows.
3. **Duplicates and order:** an event delivered twice, or a history page overlapping live events, must never duplicate or reorder messages. The timeline reducer dedupes by `seq` and sorts. Pinned in Task 5's reducer tests.
4. **Edit and delete rules:** these are refused:
   - a non-author editing;
   - an edit or self-delete after 15 minutes;
   - a member deleting someone else's message;
   - an edit of a deleted message.

   An admin deleting any message is allowed. Pinned in Task 2 (pure rules) and Task 3 (int).
5. **Attachment abuse** must be impossible: an 11 MB upload, an attachment key outside `rooms/<roomId>/<userId>/`, or an uploaded `.html` or `.svg` rendering inline (XSS).
   - **Size:** the presigned POST policy sets `content-length-range` 1..10,485,760.
   - **Keys:** `send` rejects foreign keys.
   - **Inline types:** only `image/png|jpeg|gif|webp` are shown inline; everything else downloads with `Content-Disposition: attachment`.

   Pinned in Task 4.

---

### Task 1: Live infrastructure: WebSocket API, tickets, connect/disconnect, presence, broadcast

**Files:**
- Create: `infra/lib/live.ts`, `infra/lib/live.test.ts`, `services/src/live/handler.ts`, `services/src/live/tickets.ts`, `services/src/live/broadcast.ts`, `services/src/live/presence.ts`, `services/src/live/*.test.ts`
- Modify: `infra/lib/core-stack.ts` (call `addLive(this)`, export `wsUrl`, CfnOutput `WsUrl`), `infra/lib/config.ts` (local: `s3PublicEndpoint: "http://localhost:4566"`), `scripts/src/dev-env.ts` (unchanged unless needed), `services/package.json` (`@aws-sdk/client-apigatewaymanagementapi`)

**Interfaces:**
- Produces:
  - `addLive(stack: CoreStack): { wsApi: WebSocketApi; stage: WebSocketStage; liveFn: NodejsFunction }`.
    - The WebSocket API is `cl-<stage>-ws` with `routeSelectionExpression: "$request.body.action"`.
    - Routes: `$connect`, `$disconnect`, `$default`, `send`, `edit`, `delete`, `react`, `typing`, `read`, `subscribe`, `ping`, all to Lambda `cl-<stage>-live` (with table access).
    - Stage `live`.
  - `stack.allowBroadcast(fn: NodejsFunction)`: grants management API access and sets the env `WS_CALLBACK_URL`.
    - Local: `http://${apiId}.execute-api.localhost.floci.io:4566/live`, the host Floci needs (see floci-compat.md).
    - AWS: `stage.callbackUrl`.
  - env `WS_URL` (= `stage.url`) on the `chat` Lambda (Task 3).
  - `services/src/live/tickets.ts`:
    - `newTicket(): string` (128-bit base64url);
    - `issueTicket(user: {userId, username}): Promise<{ticket: string}>`, 60 s;
    - `consumeTicket(ticket: string): Promise<{userId, username} | null>`: a conditional delete with `ReturnValues: ALL_OLD`; null if missing or expired.
  - `services/src/live/presence.ts`:
    - `isOnline(p: {conns?: number; lastPing?: number} | undefined, nowSec: number): boolean`, which is pure;
    - `markConnected(userId)`, `markDisconnected(userId)` (sets `lastSeen`), `markPing(userId)`.
  - `services/src/live/broadcast.ts`:
    - `broadcastToRoom(roomId: string, event: object, opts?: { exceptConnId?: string }): Promise<void>`: queries `CONN#` subscriptions and `MEMBER#` items in parallel, then posts only to subscriptions whose `userId` is a current member. On `GoneException` it deletes the connection's items.
    - `sendToUser(userId, event)` and `sendToConnection(connId, event)`.
  - `handler(event: APIGatewayProxyWebsocketEventV2)` in `services/src/live/handler.ts`:
    - `$connect`: consumes `?ticket=` → 401 when invalid. Writes the CONN, USER and ROOM subscription items (the rooms come from gsi1 `USER#<id>`, skipping archived ones), then `markConnected` and a `presence` broadcast to those rooms.
    - `$disconnect`: deletes the items, `markDisconnected`, `presence` broadcast.
    - `subscribe`: rewrites the subscriptions (after joining a room).
    - `ping`: `markPing` and replies `pong`.
    - Other actions: routed to `services/src/chat/actions.ts` (Task 3); until then they answer an ack error `"Not implemented"`.
  - HTTP `POST /ws/ticket` (JWT) → `{ticket, url}` lives in the `chat` Lambda (Task 3), but `issueTicket` is here.

- [ ] **Step 1: Write failing tests**
  - `live.test.ts`:
    - one WebSocket API with `RouteSelectionExpression: "$request.body.action"`;
    - all 11 route keys;
    - stage `live`;
    - the live Lambda's role allows `execute-api:ManageConnections`, and the Lambda has table access.
  - `presence.test.ts`:
    - `isOnline({conns:1,lastPing:now-60},now) === true`;
    - `isOnline({conns:1,lastPing:now-700},now) === false`;
    - `isOnline({conns:0,lastPing:now},now) === false`;
    - `isOnline(undefined, now) === false`.
  - `tickets.test.ts`: `newTicket()` is 22 base64url chars, and two calls differ.
  - Int (`services/src/live/live.int.test.ts`):
    - `issueTicket` then `consumeTicket` returns the user once; the second `consumeTicket` returns null;
    - an expired ticket (`expiresAt` set to the past) returns null.
- [ ] **Step 2: Run them; they fail** (modules missing).
- [ ] **Step 3: Implement** the files above. Reuse `docClient`/`tableName`.
- [ ] **Step 4: Run** `npm -w infra test`, `npm -w services test`, then `npm run deploy:local && npm -w services run test:int`.
  - Expected: all pass, and `npm run deploy:local` prints `WsUrl`.
- [ ] **Step 5: Commit** `feat(live): WebSocket API, one-time tickets, presence and room broadcast`.

### Task 2: Chat domain rules (pure)

**Files:**
- Create: `services/src/chat/model.ts`, `services/src/chat/model.test.ts`, `services/src/chat/mentions.ts`, `services/src/chat/mentions.test.ts`

**Interfaces:**
- Produces, in `model.ts`:
  - the protocol types above (`Reaction`, `Attachment`, `Message`) and `REACTIONS: readonly Reaction[]`;
  - `EDIT_WINDOW_SEC = 900`, `MAX_TEXT = 4000`, `MAX_ATTACHMENTS = 5`, `MAX_FILE_BYTES = 10_485_760`, `RATE_PER_MIN = 30`, `PAGE = 50`;
  - `seqKey(seq: number): string` (`MSG#` + 10-digit zero pad);
  - `messageText(raw: unknown): string`: trims; throws `ValidationError` when it isn't a string or is over 4,000 characters;
  - `canEdit(msg: {authorId; createdAt; deleted?}, userId: string, nowMs: number): boolean`;
  - `deleteMode(msg, userId, role: Role, nowMs): "self" | "admin" | null`: the author within 15 min → `"self"`; an owner or admin → `"admin"` for others' messages (their own within 15 min is `"self"`); otherwise null;
  - `excerpt(text: string): string`: first 140 characters, whitespace collapsed, `…` when cut;
  - `forReaders(stored: StoredMessage): Message`: blanks `text` when deleted and drops `textLower`;
  - `validAttachment(a: unknown, roomId: string, userId: string): Attachment`: key must start with `rooms/<roomId>/<userId>/`; size 1..MAX_FILE_BYTES; name ≤ 200 characters.
- Produces, in `mentions.ts`: `parseMentions(text: string, members: {userId; username}[]): { mentions: string[]; everyone: boolean }`.
  - Matching is case-insensitive on `@username` at a word boundary, ignoring `@` inside code spans or blocks and inside emails.
  - `@everyone` sets `everyone`.
  - The result is deduped.
- Errors reuse `ValidationError`/`Forbidden`/`NotFound`/`Conflict`/`Gone` from `rooms/model.ts`.

- [ ] **Step 1: Write failing tests** with these exact cases:
  - `canEdit` is true at 899 s and false at 901 s, false for a non-author, and false when deleted.
  - `deleteMode` covers author@10 min → `"self"`, author@20 min → null, admin on another's message@1 day → `"admin"`, member on another's → null, and owner on own@20 min → `"admin"`.
  - `excerpt("a".repeat(200)).length === 141`.
  - `messageText` rejects 4,001 characters, and `"  hi "` → `"hi"`.
  - `validAttachment` rejects `rooms/other/u/x` and a size of 10,485,761.
  - `parseMentions("hi @Alice and @bob, mail a@b.com `@carol`", [alice,bob,carol])` → mentions [alice, bob], everyone false.
  - `"@everyone"` → everyone true.
  - `forReaders` blanks a deleted message's text.
- [ ] **Step 2: Run** `npm -w services test -- chat`. Expected: FAIL (missing modules).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): message rules, mentions, limits`.

### Task 3: Messages on Floci: repo, socket actions, history, ticket route

**Files:**
- Create: `services/src/chat/repo.ts`, `services/src/chat/actions.ts`, `services/src/chat/handler.ts` (HTTP), `services/src/chat/repo.int.test.ts`, `services/src/chat/handler.test.ts`, `infra/lib/chat.ts`, `infra/lib/chat.test.ts`
- Modify:
  - `services/src/rooms/repo.ts`: createRoom/createChat also write the `CHAT#<id> META {roomId, lastSeq: 0}`; members carry `mentions: 0`;
  - `services/src/live/handler.ts`: route actions to `actions.ts`;
  - `web/lib/server/forward.ts` + its test: allow `POST /ws/ticket` and `GET /rooms/:x/chats/:x/messages`.

**Interfaces:**
- Consumes: Task 1 (`broadcastToRoom`, `sendToUser`, `issueTicket`) and Task 2 (all of `model.ts`, `parseMentions`).
- Produces: `chatRepo()` with these methods. Each checks membership with a consistent read of `MEMBER#` (NotFound when you aren't in the room) and refuses writes to an archived room with `Gone("This room is archived.")`.
  - `send(user, {roomId, chatId, clientId, text, replyToSeq?, attachments?}) → Message`:
    - rate-window check (`Conflict("Slow down: 30 messages a minute.")`);
    - `ADD lastSeq 1` on the chat META with `roomId = :r` (a NotFound if the chat isn't in this room);
    - a put with `attribute_not_exists(sk)`;
    - sets the sender's `READ` `lastReadSeq` to the new seq;
    - for each mention, or every member except the sender when `everyone`, best-effort `ADD mentions 1` on their `READ#<u>#<chat>` and `MEMBER#<u>`;
    - empty text with no attachments → ValidationError.
  - `edit(user, {roomId, chatId, seq, text}) → Message`: puts a `VER#` item with the old text, then updates `text`, `textLower` and `editedAt`. The condition repeats the rules: same author, not deleted, `createdAt` within the window.
  - `remove(user, role, {roomId, chatId, seq}) → Message`: sets `deleted` from `deleteMode`.
  - `react(user, {roomId, chatId, seq, reaction, on}) → Message`: `ADD`/`DELETE reactions.#k :userSet`. The message is created with `reactions: {}`.
  - `markRead(user, {roomId, chatId, seq}) → {lastReadSeq}`: `lastReadSeq = max`, mentions reset, and the member total decremented by the same amount in one transaction.
  - `history(user, roomId, chatId, {before?, after?, around?}) → {messages: Message[]}`: oldest→newest, ≤ 50; `around` gives 25 either side. Attachments get presigned GET `url`s from Task 4; until Task 4 lands, there's no `url`.
- `actions.ts`: `handleAction(connId, user, frame) → Promise<void>`.
  - Validates the frame and calls the repo.
  - On success: an `ack` to `connId`, plus a `message.new`/`message.updated` broadcast to the room. A `typing` broadcast skips the sender's connection. A `read` goes to the user's other connections.
  - A thrown domain error → `ack ok:false error:<message>`.
  - The user comes from the `CONN#` item (written at connect).
- HTTP handler `chat/handler.ts` (Lambda `cl-<stage>-chat`, table access, env `WS_URL`): `POST /ws/ticket` and `GET /rooms/{roomId}/chats/{chatId}/messages`.
- `addChat(stack)` in `infra/lib/chat.ts` wires those routes; the rooms Lambda also gets `allowBroadcast`.

- [ ] **Step 1: Write failing tests**
  - **Int** (`repo.int.test.ts`, Floci):
    - send allocates seq 1, 2, 3 in order, and 10 concurrent sends give 10 distinct, gapless seqs;
    - history `after=1` returns seq 2, 3;
    - the 31st send in one minute → Conflict;
    - edit by a non-author → Forbidden, and an edit after `createdAt` is moved back 16 min → Forbidden;
    - an admin removes a member's message → `deleted: "admin"`, and history shows `text: ""` while the stored item still has the text;
    - a member removing another's message → Forbidden;
    - react on then off leaves `reactions.thumbs` absent;
    - a mention increments the target's `READ.mentions` and `MEMBER.mentions`, and `markRead` sets both back;
    - a removed member's `send` → NotFound;
    - a send to an archived room → Gone (set `archived` on the member item directly);
    - a send with a chatId from another room → NotFound.
  - **Unit** (`handler.test.ts`): with a fake repo, `POST /ws/ticket` returns `{ticket, url}` with url = `WS_URL`.
  - **Infra** (`chat.test.ts`): routes exist with the JWT authorizer.
  - **Socket int** (`live.int.test.ts`, extended with the `ws` package):
    - two users connect with tickets; A sends; A gets an ack and B gets `message.new` within 2 s;
    - after B is removed from the room (repo `removeMember`), A's next message does **not** reach B, and B's `send` acks `ok:false`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run deploy:local && npm -w services run test:int`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(chat): messages over the socket with acks, history, edit/delete/react, mentions`.

### Task 4: Attachments, search, room-level actions and the richer room view

**Files:**
- Create: `services/src/chat/files.ts`, `services/src/chat/search.ts`, `services/src/chat/files.test.ts`, `services/src/chat/search.test.ts`
- Modify:
  - `infra/lib/chat.ts`: bucket `cl-<stage>-files`, private, `RemovalPolicy.DESTROY` + `autoDeleteObjects` only when the stage is local. CORS: POST and GET from `config.siteOrigins`.
  - `services/src/chat/repo.ts`, `services/src/chat/handler.ts`, `services/src/rooms/repo.ts`, `services/src/rooms/handler.ts`, `infra/lib/rooms.ts`, `web/lib/server/forward.ts` (+ tests), `services/src/rooms/repo.int.test.ts`

**Interfaces:**
- `files.ts`:
  - `attachmentKey(roomId, userId, name): string` → `rooms/<roomId>/<userId>/<uuid>/<safe name>`. A safe name keeps `[A-Za-z0-9._-]`, maps everything else to `-`, and is at most 120 characters.
  - `inlineType(type: string): boolean`: true only for `image/png|jpeg|gif|webp`.
  - `presignUpload(roomId, userId, {name, size, type}) → {url, fields, key}`: presigned POST with `content-length-range` 1..10,485,760, the `Content-Type` fixed to `type`, 5 min expiry.
  - `presignDownload(a: Attachment) → string`: GET with 1 h expiry, plus `ResponseContentDisposition: attachment; filename="<name>"` unless `inlineType`.
  - Presigned URLs use `S3_PUBLIC_ENDPOINT` when it's set. Locally that's `http://localhost:4566`, because the Lambda's own endpoint is Floci's internal address, which the browser can't reach.
- `search.ts`: `searchRoom(user, roomId, q) → {results: Message[]}`.
  - `q` is trimmed and lowercased, at least 2 characters.
  - For each chat in the room, it queries newest-first with `contains(textLower, :q) AND attribute_not_exists(deleted)`, reading at most 2,000 items per chat.
  - Returns the 30 newest overall.
- New HTTP routes (each added to the BFF allowlist):
  - `POST /rooms/{roomId}/attachments` `{name, size, type}` → presign result (chat Lambda, S3 put grant);
  - `GET /rooms/{roomId}/search?q=` (chat Lambda);
  - `PATCH /rooms/{roomId}/chats/{chatId}/prefs` `{muted: boolean}` → `{muted}` (rooms Lambda);
  - `POST /rooms/{roomId}/leave` → `{}`: owner → Forbidden. Deletes the member item and their room subscriptions, then broadcasts `room.updated`.
  - `POST /rooms/{roomId}/archive` → `{}`: owner only. Sets `archived` on META and every member item in one transaction, then broadcasts `room.updated`.
- The existing rooms writes also broadcast `room.updated`: createChat, setRole, removeMember and acceptInvite.
- `getRoomView` gains:
  - `room.archived`;
  - `chats[i]`: `lastSeq`, `unread` (`max(0, lastSeq − lastReadSeq)`), `mentions`, `muted`. It BatchGets the `CHAT#` META items; READ items come from the room query.
  - `members[i]`: `online` and `lastSeen`, from a BatchGet of `USER#<id> PRESENCE` + `isOnline`.
- `listMyRooms` gains `mentions` and leaves out archived rooms.
- `send` with attachments: `validAttachment` on each, ≤ 5. History and `message.new` carry the `url`s.

- [ ] **Step 1: Write failing tests**
  - `files.test.ts`:
    - `attachmentKey("r","u","my report (1).pdf")` matches `/^rooms\/r\/u\/[0-9a-f-]{36}\/my-report--1-.pdf$/`;
    - `inlineType("image/svg+xml") === false`, `inlineType("text/html") === false`, `inlineType("image/webp") === true`;
    - the presigned POST conditions include `["content-length-range", 1, 10485760]`;
    - a non-image download URL contains `response-content-disposition=attachment`.
  - `search.test.ts` (pure part): `normalizeQuery(" Hi ")` → `"hi"`; `"a"` throws ValidationError.
  - **Int:**
    - search finds "deploy" in two chats newest-first and skips deleted messages;
    - leave by a member works, and by the owner → Forbidden;
    - after archive, `listMyRooms` omits the room and `getRoomView` shows `archived: true`;
    - muting sets `muted` in the view;
    - unread equals 2 after two sends by someone else;
    - a POST upload to the presigned form with an 11 MB body is rejected by S3/Floci; if Floci ignores the policy, record it in `floci-compat.md` and keep the unit assertion on the conditions.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run deploy:local && npm -w services run test:int`. Expected: all pass, with any Floci gap written up.
- [ ] **Step 5: Commit** `feat(chat): attachments via presigned POST, keyword search, leave/archive/mute, unread and presence in the room view`.

### Task 5: Web live client and timeline logic (pure; can run alongside Tasks 1–4)

**Files:**
- Create: `web/lib/client/live.ts`, `web/lib/client/live.test.ts`, `web/lib/client/timeline.ts`, `web/lib/client/timeline.test.ts`, `web/components/chat/MessageText.tsx`, `web/components/chat/MessageText.test.tsx`, `web/lib/client/sound.ts`
- Modify: `web/lib/types.ts` (the protocol types, mirrored), `web/vitest.config.ts` (include `components/**/*.test.tsx`), `web/package.json` (`react-markdown`)

**Interfaces:**
- `live.ts`:
  - `backoffMs(attempt: number, random: () => number): number`: `min(30000, 1000 × 2^attempt) × (0.8 + 0.4 × random())`.
  - `class LiveSocket`:
    - **Construction:** `new LiveSocket({ getTicket: () => Promise<{ticket, url}>, WebSocketImpl?: typeof WebSocket })`.
    - **Methods:** `start()`, `stop()`, `request(action, args) → Promise<unknown>` (resolves on `ack ok`, rejects `Error(error)` on `ok:false` or after the 10 s timeout), `on(type, fn) → unsubscribe`.
    - **State:** `status: "connecting" | "open" | "closed"`, with `onStatus(fn)`.
    - **Behaviour:** pings every 4 min while open. On close it reconnects with `backoffMs`, fetching a fresh ticket each time. After every (re)open it emits a local `{type:"reconnected"}` event, so views can fetch missed messages.
- `timeline.ts`: `type Timeline = { messages: Message[]; pending: PendingMessage[] }` where `PendingMessage = {clientId, text, replyTo?, attachments, failed?: boolean}`.
  - `applyMessages(t: Timeline, incoming: Message[]): Timeline`: upserts by `seq`, sorts ascending, and removes pending entries whose `clientId` arrived.
  - `addPending(t, p)`; `failPending(t, clientId)`.
  - `newestSeq(t): number` (0 when empty).
- `MessageText({ text, members, onTag? })`:
  - react-markdown with `allowedElements` `p, strong, em, code, pre, a, br, del`, `unwrapDisallowed`, and `skipHtml`;
  - links: `target="_blank" rel="noopener noreferrer"`, http(s) only (others become text);
  - `@username` of a current member, and `@everyone`, render as `<span class="mention">`. Matching uses the same rules as `parseMentions`, mirrored in `web/lib/client/mentions.ts`.
- `sound.ts`: `playMentionTick()`: a WebAudio sine, 880 Hz, 60 ms, gain 0.04, that never throws (an autoplay block is ignored). Nothing else plays sound.

- [ ] **Step 1: Write failing tests**
  - `backoffMs(0, () => 0.5) === 1000`; `backoffMs(10, () => 0.5) === 30000`; `backoffMs(1, () => 0) === 1600`.
  - **LiveSocket, with a fake WebSocket class:**
    - `request` resolves on a matching ack, and rejects with the server's error on `ok:false`;
    - it rejects after 10 s (`vi.useFakeTimers`);
    - after the socket closes, it reconnects using a new ticket and emits `reconnected`.
  - **timeline:**
    - applying the same message twice keeps one;
    - out-of-order `[3, 1, 2]` → `[1, 2, 3]`;
    - an incoming message whose clientId matches a pending one removes that pending entry;
    - `message.updated` with the same seq replaces the text.
  - **MessageText** (`renderToStaticMarkup`):
    - `**b**` → `<strong>`;
    - `<script>x</script>` produces no `<script`;
    - `# Title` has no `<h1`;
    - `[x](javascript:alert(1))` has no `href="javascript`;
    - `@alice` (a member) → `class="mention"`, and `@stranger` stays plain.
- [ ] **Step 2: Run** `npm -w web test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): live socket with tickets/acks/reconnect, timeline reducer, light markdown`.

### Task 6: The chat UI

**Files:**
- Create:
  - `web/components/chat/ChatView.tsx` (timeline + composer for one chat);
  - `web/components/chat/MessageList.tsx` (loads older messages on scroll-to-top, keeping the scroll anchored; sticks to the bottom when you are there; shows "N new messages ↓" when you are scrolled up);
  - `web/components/chat/MessageRow.tsx` (a hover toolbar with react, reply, edit and delete; a reactions row; "(edited)"; deleted stubs; attachments);
  - `web/components/chat/Composer.tsx`;
  - `web/components/chat/TypingLine.tsx`;
  - `web/components/chat/Attachments.tsx`;
  - `web/lib/client/LiveProvider.tsx`: one `LiveSocket` per tab, in the room layout; `getTicket` = `bff("/bff/api/ws/ticket", {body: {}})`.
- Modify: `web/app/r/[roomId]/c/[chatId]/page.tsx` (fetch the first page server-side, render `ChatView`), `web/components/shell/RoomShell.tsx` (wrap it in `LiveProvider`)

**Behaviour (pinned):**
- **Composer:**
  - **Keys:** Enter sends, Shift+Enter adds a new line. Up-arrow in an empty composer edits your last message if it's still editable.
  - **Editing:** Esc cancels an edit or reply.
  - **@ autocomplete:** a list of members plus `everyone`.
  - **Attachments:** paste, drag-drop or a clip button. Each file uploads via `POST /rooms/:x/attachments`, then the presigned POST, with an upload chip showing the size. Files over 10 MB are refused in the UI with a toast. At most 5.
  - **Typing:** sends `typing` at most every 3 s while you type.
  - **Archived room:** the composer is replaced by "This room is archived."
- **Sending:** `addPending`, then `live.request("send", …)`.
  - On ack, `applyMessages([ack.data])`.
  - On error, `failPending` + a toast with the reason, and "Retry" on the row.
- **Live events:**
  - **Messages:** `message.new` and `message.updated` for this chat go through `applyMessages`. For another chat they bump its sidebar badge (Task 7).
  - **On reconnect:** fetch `messages?after=<newestSeq>` and apply.
- **Reading:** while the chat is visible and scrolled to the bottom, send `read` with the newest seq (debounced 1 s).
- **Typing line:** under the list, "alice is typing…" / "alice and bob are typing…", fading in and out. Entries clear after 5 s.
- **Mention sound:** a `message.new` that mentions me, or `everyone`, from someone else plays `playMentionTick()`.
- **Deleted stubs:** "Message deleted" (self) or "Removed by an admin" (admin), in italic tertiary text, without the attachments.
- **Quote-reply:** a small bordered quote line above the text: author + excerpt. Clicking it jumps to that message: it's loaded with `around`, then flashes.
- **Images:** an inline preview (max 320×240, with reserved aspect ratio so there's no layout shift; clicking opens the original). Other files are a chip with the name, size and a download link.
- **Motion:** as in Global Constraints. Reduced motion = instant.

- [ ] **Step 1: Write failing tests** for the pure helpers this task adds:
  - `typingText(names: string[]): string`: `[] → ""`, `["a"] → "a is typing…"`, `["a","b"] → "a and b are typing…"`, `["a","b","c"] → "3 people are typing…"`;
  - `canEditLast(messages, me, now)` picks your newest non-deleted message within 15 min.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement** the components and helpers.
- [ ] **Step 4: Run** `npm -w web test && npm run check`, and check by hand with two browser contexts against `next dev` (a quick puppeteer script in the scratchpad is fine). Expected: tests pass; messages, typing, reactions, edit, delete and an image attachment work between the two users.
- [ ] **Step 5: Commit** `feat(web): live chat view: messages, composer, reactions, replies, edit/delete, attachments, typing`.

### Task 7: Shell: badges, presence, mute, search, leave/archive, phone layout

**Files:**
- Modify: `web/components/shell/Sidebar.tsx`, `RoomSwitcher.tsx`, `Header.tsx`, `RoomShell.tsx`, `Panel.tsx` (a Search tab), `web/components/rooms/MemberList.tsx` (presence)
- Create: `web/components/chat/SearchPanel.tsx`, `web/components/shell/MobileNav.tsx`, `web/lib/client/badges.ts` (+ test)

**Behaviour (pinned):**
- **Sidebar chat rows:**
  - an unread count, hidden when muted;
  - a lime mention badge `@N`, which always shows;
  - counts pop on change;
  - a row menu with Mute/Unmute (PATCH prefs).
- **Badge logic** (`badges.ts`): `chatBadge({unread, mentions, muted}) → {count: number | null, mention: number | null}`. Live `message.new` events for other chats bump the counts in local state; `room.updated` and `read` events reconcile them.
- **Room switcher:** a small lime dot beside rooms with `mentions > 0`. Menu items: "Leave room" (members and admins; confirm modal) and "Archive room" (owner; the confirm modal says it becomes read-only and hidden).
- **Header and members:**
  - **Presence:** the header's avatar stack and the member list show a static lime dot when online; otherwise the member list says "last seen 5m ago" (relative, refreshed every minute). `presence` events update it live.
- **`room.updated`:** calls `router.refresh()`. If I am no longer a member, I go to `/` with a toast: "You're no longer in <room>".
- **Search:**
  - **Opening it:** a header search button and the Ctrl K item "Search messages…" open the panel's Search tab.
  - **Querying:** debounced 300 ms; results are grouped by chat with the author, time and the match highlighted.
  - **Results:** clicking one navigates to the chat with `?m=<seq>` and the message flashes.
- **Phone width (< 768 px):**
  - **Sidebar:** becomes a drawer, opened by a header menu button, that slides from the left with a backdrop.
  - **Panel:** overlays from the right.
  - **Layout:** no horizontal scroll, and the composer stays above the on-screen keyboard (`h-dvh`).

- [ ] **Step 1: Write failing tests:**
  - `chatBadge({unread:3,mentions:0,muted:false})` → `{count:3,mention:null}`;
  - `{unread:3,mentions:1,muted:true}` → `{count:null,mention:1}`;
  - `{unread:0,mentions:0,muted:false}` → both null;
  - `lastSeenText(now − 5 min)` → `"last seen 5m ago"`; 3 h → `"last seen 3h ago"`; 2 days → `"last seen 2d ago"`.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm -w web test && npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): unread/mention badges, presence, mute, search, leave/archive, phone layout`.

### Task 8: End-to-end smoke and the learn doc

**Files:**
- Modify: `scripts/src/smoke.ts` (and helpers), `docs/learn/floci-compat.md` (any new gaps), `docs/learn/README.md` (study-list row)
- Create: `docs/learn/03-live-chat.md`

**Smoke checks to add** (the real UI with two isolated browser contexts, owner and guest, in the same room; each is a `check()` line):
1. A sends "hello @guest" in the UI → B sees it live within 2 s, and B's sidebar mention badge shows 1 when B is in another chat.
2. B typing shows "… is typing…" for A.
3. B reacts 👍 → A sees the chip. A edits within 15 min → B sees "(edited)". A deletes → B sees "Message deleted".
4. Quote-reply shows the quoted excerpt.
5. An image attachment uploads and shows inline for B; an 11 MB file is refused in the UI.
6. **Reconnect:** close A's socket from the page (`window.__live.socket.close()`, exposed only when `NODE_ENV !== "production"`). B sends a message. A shows it after reconnecting.
7. B mutes the chat → the unread count hides, but a new @mention still shows the badge.
8. Search "hello" finds the message; clicking it flashes it.
9. Rate limit: the 31st API-level send within a minute acks an error.
10. **Removal:** the owner removes B → B is sent to `/` with the toast, and B's open socket no longer gets the room's messages.
11. Leave and archive: a third user leaves; the owner archives → the room disappears from the switcher and the composer shows "This room is archived."
12. **Phone width:** at a 390×844 viewport, no horizontal scroll (`scrollWidth ≤ innerWidth`), the drawer opens from the menu button, and the composer is visible.
13. **Motion:** the reduced-motion checks still pass, and the new message entrance has 0 frames in motion under reduced motion.

**Learn doc `03-live-chat.md`** (same shape as 02):
- what was built and how to try it;
- the patterns, each a short interview-ready paragraph:
  - WebSocket route selection;
  - ticket auth (and why not a token in the URL);
  - acks and optimistic UI;
  - per-chat sequence numbers and gap-fill on reconnect;
  - fan-out on write with member filtering;
  - presence by heartbeat;
  - the fixed-window rate limit;
  - soft delete with version history;
  - presigned POST uploads;
  - search by filtered query and its limits;
- the rulings from Global Constraints;
- Floci notes;
- "How big companies do it": Slack/Discord gateways, sharded fan-out, presence services, Elasticsearch/OpenSearch search, CDN-served attachments.

- [ ] **Step 1: Add the smoke checks**; run `WEB_URL=http://localhost:3100 npm run smoke`. Expected: new checks fail first wherever behaviour is missing; fix, then **all** pass.
- [ ] **Step 2: Write the learn doc** and the study-list row.
- [ ] **Step 3: Run everything:** `npm test`, `npm run check`, `npm -w services run test:int`, `npm run smoke`. Expected: all green.
- [ ] **Step 4: Commit** `test: live chat end-to-end; docs: step 3 learn doc`.
