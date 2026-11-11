# Step 3: Live people chat

## What we built
- **A WebSocket API** (`cl-<stage>-ws`, stage `live`) with one Lambda behind every route. Messages, typing, reactions, read marks and presence all travel over it.
- **Messages with the usual chat features:**
  - live delivery with an ack, and your own message shown at once while it's in flight;
  - @mentions (including `@everyone`) with a soft sound and badges;
  - the six reactions 👍 ❤️ 😂 🎉 👀 ✅;
  - quote-replies (no sub-threads);
  - edit and delete within 15 minutes, plus admin removal at any time. Nothing is really deleted: every earlier version stays in DynamoDB;
  - light markdown: bold, italic, code, links, mentions and #tags.
- **Files up to 10 MB,** uploaded straight from the browser to S3. Images preview inline; anything else downloads.
- **Unread and mention badges** in the sidebar, mute per chat, and a mention dot on the room switcher.
- **Presence:** a static online dot, or "last seen 5m ago".
- **Search** across a room's chats, with the match highlighted and a click that jumps to the message.
- **Leave and archive.** Archived rooms are read-only and hidden from the list.
- **Phone width:** the sidebar becomes a drawer and the panel an overlay.
- **`npm run smoke`** now drives two (sometimes three) real browsers through all of it: 44 checks.

## How to try it
```powershell
npm run floci:up; npm run deploy:local       # WebSocket API, chat Lambdas, files bucket on Floci
npm run dev                                  # http://localhost:3000
npm run grant -- <you> creators              # sign out and in, create a room, invite a second browser profile
npm run smoke                                # the end-to-end check (needs npm run dev running)
npm -w services run test:int                 # repo and socket tests against Floci
```
Open the same room in two browser profiles (not two tabs of one profile: they share the cookie, so you'd be the same person). Type in one and watch the other. To see the reconnect catch-up, run `__live.ws.close()` in one profile's console (dev builds only) and send from the other.

## How a message flows
```mermaid
sequenceDiagram
  participant B as Browser
  participant N as Next.js BFF
  participant H as HTTP API (JWT)
  participant W as WebSocket API
  participant L as live Lambda
  participant D as DynamoDB
  B->>N: POST /bff/api/live/ticket (cookie)
  N->>H: POST /live/ticket, Bearer ID token
  H-->>B: {ticket, url} (ticket lives 60 s, one use)
  B->>W: connect url?ticket=…
  W->>L: $connect
  L->>D: delete WSTICKET (only if unexpired) → who you are
  L->>D: put CONN, USER#/CONN#, ROOM#/CONN# per room
  B->>W: {action:"send", requestId, roomId, chatId, clientId, text}
  W->>L: route "send"
  L->>D: member? rate window? ADD lastSeq 1 → seq; put MSG#seq
  L-->>B: {type:"ack", requestId, ok:true, data: message}
  L->>D: query ROOM#/CONN# + MEMBER# (current members only)
  L->>W: postToConnection to each member socket
  W-->>B: {type:"message.new", message} (to everyone else)
```

## The patterns
**WebSocket route selection.** API Gateway reads `$request.body.action` from every frame and picks a route by its value (`send`, `edit`, `react`, `typing`…). Frames that match nothing go to `$default`; `$connect` and `$disconnect` fire when sockets open and close. Here all routes share one Lambda and one integration, and the Lambda switches on the action. One Lambda per route would let each scale and be permissioned separately, but the actions share nearly all their code (membership checks, the repo, fan-out), so one function is simpler and keeps one warm container. The browser never talks HTTP to that Lambda; API Gateway holds the socket, and the Lambda only runs per frame. That is why it scales to zero.

**Ticket auth, and why not a token in the URL.** A browser can't set headers on a WebSocket, so the credential has to ride in the URL, and URLs get logged: API Gateway access logs, CloudWatch, proxies, browser history. Our ID token is also an httpOnly cookie on our own domain, which page JavaScript can't read and which isn't sent to the execute-api host anyway. So the BFF asks the HTTP API (JWT-checked as usual) for a **ticket**: 128 random bits, valid for 60 seconds, usable once. `$connect` consumes it with a conditional delete (`expiresAt > now`, return the old item), so a replay or an expired ticket gets 401. A ticket in a log line is worthless a minute later, while a leaked ID token is good for an hour.

**Acks and optimistic UI.** Every client frame carries a `requestId`, and the server answers each with exactly one `ack` (ok with data, or an error string). The client keeps a map of pending requests and times them out at 10 s. Your own message shows at once at 60 % opacity with a client-made `clientId`, and the ack swaps it for the stored copy (same React key, so it doesn't re-enter). The fan-out to everyone else runs after the ack, so a slow or failed fan-out can never produce a second, contradictory answer. Sends aren't idempotent on `clientId`, so after a timeout the client doesn't resend by itself: the row says "Not sent" with Retry, and the reconnect catch-up removes it if the original did land.

**Per-chat sequence numbers and gap-fill on reconnect.** Each chat has a counter item (`CHAT#<id> META`). `ADD lastSeq 1` with the condition `roomId = :r` hands out the next seq atomically **and** proves the chat belongs to that room in the same write. Every refusal (empty text, not a member, rate limit) happens before that write, so refused sends never leave holes. Messages are stored at `MSG#<seq, 10-digit padded>`, so a range query reads them in order. The client remembers the newest seq it has per open chat; when the socket reopens it fetches `?after=<seq>` until a short page comes back. The timeline reducer dedupes by seq and sorts, so an event delivered twice, or a page overlapping live events, can't duplicate or reorder anything.

**Fan-out on write with member filtering.** On connect, the server writes one `ROOM#<room> / CONN#<conn>` item per room the user is in. To broadcast, it queries that partition and a consistent read of the room's `MEMBER#` items in parallel, and posts only to sockets whose user is still a member. That filter is what makes removal real: a removed member's socket is still open, and still has a stale subscription item, but it hears nothing more. Every action also checks membership itself, so their sends are refused. A post that answers `GoneException` deletes that connection's items. The cost is one `postToConnection` per socket per event; see "How big companies do it" for where that stops scaling.

**Presence by heartbeat.** `USER#<id> PRESENCE` holds `conns` (open sockets), `lastPing` and `lastSeen`. Connect adds 1, disconnect subtracts 1, and the client pings every 4 minutes because API Gateway drops sockets idle for 10. Online means `conns > 0 AND lastPing within 11 minutes`. The second half heals drift: a socket that dies without `$disconnect` (a laptop lid closing) leaves `conns` too high, but its pings stop, so the user goes offline anyway. Only the caller whose delete actually removed the `CONN` item decrements, so `$disconnect` and Gone cleanup can't both count the same socket.

**The fixed-window rate limit.** `RATE#<user> / <epoch minute>` gets `ADD n 1` on every send, with a TTL of two minutes. If the returned `n` is over 30, the send is refused with "Slow down: 30 messages a minute." It's one atomic write and no reads. The known flaw: a burst of 30 at 0:59 and 30 more at 1:00 gets 60 through in two seconds. A sliding window (two buckets weighted by overlap) or a token bucket fixes that; for a chat app the fixed window is enough.

**Soft delete with version history.** A delete sets `deleted: "self" | "admin"`; the text and files stay in the item. Every read goes through `forReaders`, which blanks `text` and `attachments` for deleted messages, so "deleted" files can't be downloaded either. An edit writes `VER#<seq>#<editedAt> {text: old}` and updates the message in one transaction. The update's condition repeats the rules (your message, not deleted, within 15 minutes) and also requires the text to still be what we read: an optimistic lock, so the version item always holds exactly the text that was replaced. Readers see only "(edited)". This is how you answer "the user deleted it, but legal needs it": the data is there, and only the read path hides it.

**Presigned POST uploads.** The browser asks the API for an upload form; the API checks membership and the declared size and type, then signs a POST policy for the key `rooms/<room>/<user>/<id>/<name>` with `content-length-range 1..10,485,760`. The browser posts the file straight to S3, so no Lambda ever handles the bytes. A presigned **POST** (not PUT) is used because only a POST policy can enforce a size range. `send` then refuses any attachment key outside the sender's own prefix. Downloads are presigned GETs that force the response headers: images (png, jpeg, gif, webp only) come back with the declared type, everything else as `Content-Disposition: attachment`. So an uploaded HTML or SVG file never renders on a page, and a file uploaded as `text/html` but declared as `image/png` is served as `image/png`.

**Search by filtered query, and its limits.** Each message stores `textLower`. Search queries each of the room's chats newest-first with the filter `contains(textLower, :q) AND attribute_not_exists(deleted)`, stops at 30 matches or 2,000 items read per chat, then merges by time. It's honest about what it is: a DynamoDB filter runs **after** the read, so you pay for every item scanned, not every match. There's no ranking and no stemming ("deploy" finds "deployed" only because it's a substring; "run" never finds "ran"), and messages older than the latest 2,000 per chat are invisible to it. Real search means a search index; see below.

## Rulings
These were judgement calls during the build. Each line says what we chose and what it costs if the choice turns out wrong.

**Limits and timings**
| Ruling | Cost if wrong |
|---|---|
| Message text ≤ 4,000 characters | Long pastes need splitting; raising it is a constant |
| ≤ 5 attachments per message | One more send for a sixth file |
| History pages of 50 | More round trips when scrolling far back |
| Search: query ≥ 2 characters, ≤ 30 results, ≤ 2,000 latest messages per chat | Older matches are missed until a real index exists |
| Ticket TTL 60 s | A very slow network could need a second ticket fetch (the client retries) |
| Ping every 4 min (API Gateway drops idle sockets at 10) | Too slow and sockets drop; too fast and each ping is a Lambda call |
| Reconnect backoff `min(30 s, 1 s × 2^attempt)` ± 20 % jitter | A long outage reconnects up to 30 s late; the jitter keeps clients from reconnecting in lockstep |
| Ack timeout 10 s | A very slow ack marks a message "Not sent" that did land; catch-up removes the row |
| Typing sent at most every 3 s, shown for 5 s | "Is typing…" may linger up to 5 s after someone stops |
| WebSocket stage name `live` | None |

**Design calls**
| Ruling | Cost if wrong |
|---|---|
| The web client mirrors `parseMentions` (`web/lib/client/mentions.ts`) so mentions highlight without a round trip | Two copies to keep in step |
| `window.__live` exposes the socket only when `NODE_ENV !== "production"` | None |
| The socket URL in outputs is the one a browser can reach (the Floci host locally) | None |
| Connection items live in their own module; the `CONN` item also stores its `roomIds` so disconnect knows what to delete | One extra attribute per connection |
| Deleting a message reads the role from the same membership read, not from the caller | None |
| `around=n` returns 25 before, n, and 24 after (one page of 50) | None |
| Mentions never count for the sender, named or via `@everyone` | None |
| Sends aren't idempotent on `clientId`; the client never auto-resends after a timeout, it offers Retry | A rare duplicate on a manual retry |
| Archive is one transaction, so it's capped at 97 members (meta + members + invite delete + revoke ≤ 100 items) | Bigger rooms get "can't be archived yet" until archive is batched |
| Archived rooms refuse joins, new chats and invite rotation as well as messages | None |
| The ticket route is `POST /live/ticket`, not `/ws/ticket`, because Floci answers every `/ws/*` path itself | None |
| Edits re-parse mentions on the server, and the stored counts follow: someone the edit newly names gets a mention, and a mention the edit removed stays until read | A stale badge, cleared by reading the chat |
| The open sidebar doesn't count badges from `message.updated`, only from `message.new`. So an edit that adds a mention of you shows no badge live, and a later message doesn't bring it either; it appears when the room view is next fetched (a reload, a room switch or a `room.updated`) | A missed mention badge until then |
| After leaving, archiving or being removed you go to your next room, not `/`, because home sits outside the layout that owns the socket | None |
| Deleted messages hide their files as well as their text | None |
| Inline images are served with the declared type forced, so an upload can't change how it renders | None |

**Process**
| Ruling | Cost if wrong |
|---|---|
| The S3 public endpoint setting was built with the bucket, not with the socket infrastructure | None |
| Independent parts were built in parallel git worktrees and merged | A lockfile merge fix-up commit |
| Worktree agents branch from `master`, not from the step branch, so their review base differs (only the plan doc was missing) | None |
| Small review findings were folded into the next change touching the same files, listed below | Bigger diffs to review |

What was folded in, and where:
- **Into the attachments and search work:**
  - consistent reads of the chat counter in history;
  - read marks and typing proving the chat is in the room (a `ConditionCheck`);
  - the error classes moved to `lib/errors.ts`;
  - empty cursors refused.
- **Into the archive fix round:**
  - broadcasts made best-effort;
  - a clear error above the archive member cap;
  - the room view reading only the caller's `READ#` items, with pagination;
  - a retry cap on `BatchGet`;
  - the leaver's other tabs hearing `room.updated`.
- **Into the chat view fix round:**
  - memoised message rows;
  - no load-older retry loop;
  - images contained, not cropped;
  - the time-zone cookie set at sign-in;
  - accessibility (reaction labels, the @ list as a combobox, roving toolbar focus);
  - "Connecting…" vs "Reconnecting…";
  - optimistic changes reverted from the latest copy;
  - the timeline hook split out;
  - one socket per tab;
  - tighter grouping.
- **Into the shell work:**
  - the ticket route rename;
  - server-side mention re-parsing on edit;
  - a ping sent without waiting for an ack (the server answers `pong`, not an ack);
  - the phone layout;
  - sidebar badges and `room.updated`.

## Floci notes
- **`/ws/*` is taken.** Floci answers any `/ws/...` path on an execute-api host itself (an empty 403) before routing, so the ticket route was renamed to `/live/ticket`.
- **`$disconnect` timing varies.** After a clean `ws.close()`, the offline presence event arrived anywhere from about 1 s to over 20 s later. Closing the page was prompt. On AWS it arrives within seconds.
- **Floci's GSI queries see writes at once,** so the one eventually consistent read (the gsi1 query in `subscribe`) can't show its race locally. On AWS a `subscribe` sent the instant after joining could miss the new room until the next one.
- **No transaction conflicts.** Floci doesn't simulate `TransactionConflict`, so concurrent transactions that would clash on AWS (two simultaneous accepts, an accept racing an archive) are untested and currently surface as 500s.
- **S3:** presigned URLs are signed against `http://localhost:4566` path-style, because the Lambda's own S3 endpoint is a Docker address. Floci enforces the POST size range, bucket CORS and the forced response headers.
- **`autoDeleteObjects` fails** (its helper Lambda calls S3 on port 443), so the local bucket is just `RemovalPolicy.DESTROY`. A failed stack update can't roll back either: delete the stack and deploy again.
- **The store slows down as it grows.** After many runs, writes took 350 ms and up; resetting the Floci volume fixed it.

## Known limits
- Fan-out posts to every socket in parallel with no cap. Fine for rooms of tens of people; a big room needs batching or a queue.
- Presence is broadcast once per shared room, so someone sharing two rooms with you sends each event twice. Harmless (the client merges by user) but wasteful.
- Presigned GET URLs last an hour, so an image in a tab left open longer breaks until the history is fetched again.
- Search is a filtered scan (above).

## How big companies do it
- **Gateways:** Slack and Discord each run their own connection gateway (Discord's is written in Elixir). The gateway only holds sockets and routes events, and the business logic lives in other services. That is the same split as API Gateway holding the socket while Lambda does the work. Discord's documented gateway protocol uses a session id plus a sequence number, so a client that reconnects asks to **resume** from its last seq, much like our `after=` catch-up.
- **Sharded fan-out:** instead of one writer posting to every socket, events go onto a pub/sub layer sharded by channel (Kafka, Redis pub/sub or in-house channel servers). Each gateway subscribes only to the channels its connected users are in, so a message to a huge channel is published once and copied out by the gateways. Very large rooms also get lighter treatment: Discord's gateway marks servers above a size threshold as "large" and stops sending their full member lists up front.
- **Presence services:** presence is the noisiest data in chat, so it usually gets its own service with heartbeats, short TTLs and batching, and clients subscribe only to the people they are actually showing.
- **Search:** messages are copied into a search index (Discord has written about indexing its messages in Elasticsearch), with tokenising, stemming and ranking, and filtered by the channels you can read. DynamoDB Streams → OpenSearch is the AWS version of this.
- **Attachments:** uploads go straight to object storage with signed URLs, as here, and downloads come from a CDN on a separate domain (Slack's `files.slack.com`, Discord's `cdn.discordapp.com`), so a malicious file can't run script on the app's origin. CloudFront with signed URLs or cookies is the AWS version.
- **Rate limits:** usually token buckets per user and per channel, kept in a fast shared store, with separate limits for bots.

## Interview angle
- "How do you authenticate a WebSocket from a browser?" You can't set headers, so trade the session for a short-lived, single-use ticket over HTTPS, pass it in the URL, and consume it atomically on connect.
- "How do you make sure a client doesn't miss messages?" Per-conversation sequence numbers allocated atomically, acks for writes, and resume-from-seq on reconnect; dedupe by seq on the client.
- "Someone is removed from a channel but their socket is still open. What happens?" Fan-out filters by current membership at send time, and every action re-checks membership; the socket stays open but hears nothing from that room.
- "Why is your rate limit not exact?" It's a fixed window; explain the boundary burst and the sliding-window or token-bucket fix.
- "Where does chat search come from?" Not the primary database: a search index fed by a change stream.
