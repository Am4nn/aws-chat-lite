# Whole-app audit (2026-11-12)

## What we did
After step 11, three read-only audits went over the whole app before anything reached AWS:
- **Spec conformance:** 126 rows of the design spec checked against code and tests. 95 were present and tested, 11 diverged for a written reason, and the rest were gaps, untested or partial.
- **Code quality, services:** bugs, copies, dead code, comments and names in `services/src` (about 13,000 lines).
- **Code quality, web, infra and scripts:** the same for the web app, the CDK app and the scripts, plus UI consistency.

The headline was good. No model call skips the budget check, no path sends private text to DeepSeek, no route skips its membership check, the approval gate and the SSRF guard held up under active probing, and no secret was in git. Three agents then fixed what the audits found, one per area. A last batched run checked their work together on a fresh Floci.

## What it found and changed
**Real bugs**
- **Two kinds of item shared one key prefix.** GitHub and MCP links were `ROOM#<id> / CONN#…`, the same prefix as the room's socket subscriptions. So every broadcast read the room's MCP tool snapshots as well. The query wasn't paginated either, so a big room could silently drop sockets. Links are now `LINK#github` and `LINK#mcp#<name>`, and the member, socket and link queries all page. The lesson for single-table design: a sort-key prefix is a type tag, and `begins_with` can't tell two types apart that share one.
- **A failed broadcast could stop the agent.** If `message.new` failed to send, `route()` never ran, so an `@agent` message went unanswered. The broadcast is now best effort, and routing always runs.
- **Two plays of the same answer paid Polly twice.** Read aloud now takes a claim item, `SPEECH#<chat>#<seq>`, with a 60 s ttl, written with a condition before it synthesizes. A second play meanwhile is told "Preparing the audio; try again in a moment" and later gets the cached MP3. A failed synthesis releases the claim; one left by a crash expires and is taken over, since TTL deletion can lag by days.
- **Deleting a message left its thread copy readable.** A message copied into an agent thread now carries the copy's seq. The delete marks both in one transaction and broadcasts both. Edits don't carry over: the agent already took the copy as its input, and deletion is the moderation and privacy case.
- **Archiving didn't reach work already under way.** A run's limit check now reads `archived` from the room META it already loads, so a running thread ends with "The room was archived." Approval decisions in an archived room are refused with 410, and read aloud makes no new audio there.
- **The BFF gave up after 8 s,** while voice and MCP connect may take 25–30 s on purpose. It now has one 29 s budget: under the HTTP API's 30 s cut, and under the web Lambda's own 30 s, so the app answers its own 504 rather than CloudFront's.

**Promises the docs made that code didn't keep**
- **The audit log missed steps.** Image, sandbox and helper hand-off steps are now audited, and an image that wasn't approved isn't listed (audit lists what ran).
- **Images could carry private data out.** In a private (tainted) thread, `image_generate` now asks first, like web calls do, because the prompt goes to Gemini.
- **The AWS idle floor.** It was likely $6–7 a month, not "a few dollars". Most of it was a 75-metric dashboard: CloudWatch bills a dashboard past 50 metrics. Dropping per-function duration and throttle graphs brought it to 37 metrics. Those are causes, and each function's Monitor tab shows them. The runbook now prices the floor at about $3.30–4.30 a month and sets a $10 Claude Console limit first.

**Cleanups**
- **Services:** one `bestEffort` instead of ten hand-written try/catch wrappers; key builders in `lib/keys.ts`; the transaction-conflict retry and `withoutKeys` in `lib/db.ts`; `runs/steps.ts` (534 lines) split into routing, model turn and tool step; compat shims for data that no longer exists removed.
- **Web:** one `useOutbox` for both composers, one `useRoomData` that shows "Couldn't load · Retry" on a failed panel load (and, later, the invite panel too, which reads a 404 as "no link" and any other failure as a retry), a `RoomShell` split, colour and shadow tokens in place of 57 hand-written hex shades, two-letter avatars, and panel tabs with one Tab stop and arrow keys. `npm run check` now also runs the two React hooks lint rules.
- **Infra and scripts:** shared CoreStack helpers, the web Lambda at 30 s, named ports, one frame sampler and one `confirmDialog` shared by the smoke files.

## How it was checked
Each area's agent worked on its own branch with unit tests only. Floci is shared and slow, so one runner merged the three branches, reset Floci, deployed it and ran everything once: the unit suites, `npm run check`, the full services integration suite, the browser smoke twice on fresh deploys, and a strict credential-less AWS synth with cdk-nag. The rulings and counts are in `.superpowers/sdd/audit-fixes/progress.md`.

That run found what the lanes' unit tests couldn't. Three integration cases still expected the old shapes (a delete's result, a usage counter that was dropped). And the browser smoke caught a regression: after a refactor, a new memory entry was marked "new" in an effect, one render after it mounted. Motion reads a row's entrance only when it mounts, so the entry appeared in place instead of sliding in. It is now marked while rendering. Animation is behaviour too, and only a real browser sees it.

## Rulings
| Ruling | Cost if wrong |
|---|---|
| The `LINK#` re-key has no migration: Floci data is disposable and AWS has none | An old local room loses its GitHub and MCP links until they are added again |
| Sending or starting a thread is still not idempotent on the client id; the web client warns before a retry | A lost ack then a retry posts twice |
| Archive stops runs from the run side, and the rooms function now also cancels and wakes runs waiting on an approval, so they end at once (Aman's call, after the audit) | A wake the callback API drops leaves that run waiting until its approval expires |
| Owners can still change roles and remove members in an archived room: archiving freezes content, not who may read it | An admin can still change roles in a closed room |
| Rate-limit gap left: a refused send still counts. Edits and reactions now share their own cap of 60 a minute per member and room, apart from the 30 sends (Aman's call, after the audit) | A refused send still uses one of 30 |
| The dashboard keeps per-function errors and drops duration and throttles | One more console click when diagnosing |

## Settled after the audit
Aman decided four of the open points:
- **Edits and reactions are capped,** 60 a minute per member and room on a counter of their own, so reactions can't block sends (see 03).
- **People chats can be renamed and archived** by admins, never deleted; an archived chat is read-only and out of the sidebar but readable by link and in search, and the room's first chat can't be archived (see 03).
- **Archiving a room ends a run waiting on an approval at once,** by cancelling the approval and waking the run, as a stop does (see 07).
- **The invite panel retries** a failed first load like the other panels.

Still open: a refused send still uses one of the 30 a minute.

## How big companies do it
- **Launch reviews** before a service takes real traffic: a checklist of security, operations and cost questions (AWS's Operational Readiness Reviews, Google's production readiness reviews), each answered with evidence.
- **Spec traceability:** each requirement maps to the code and the test that prove it, so a gap shows as an empty cell, not a surprise in production.
- **Policy as code and linters in CI** catch the mechanical part (cdk-nag, knip, hooks rules) on every change, so human reviewers spend their time on behaviour.

## Interview angle
- "How would you audit an app you built?" Split it: does the code do what the spec says (conformance), and is the code good (quality). Read only, with evidence for every finding, graded so the list sorts itself. Then fix in parallel lanes that can't touch each other's files, and verify together once.
- "Your single-table design has two item types under one prefix. Why does it matter?" Every `begins_with` query reads both, so a hot path pays for the other type's items, and pagination limits hit sooner. Prefixes are the type system of a single table.
- "How do you stop a double click charging twice?" A claim item written with a condition, with a ttl so a crash doesn't hold it forever, taken before the paid call and released if it fails.
- "Why 29 seconds?" Every timeout in a chain should be shorter than the one outside it, so the layer that knows the most writes the error.
