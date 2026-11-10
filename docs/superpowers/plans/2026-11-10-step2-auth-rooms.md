# Step 2: Auth + Rooms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People can sign up, sign in, create rooms (creators only), make people chats, invite others with a link, and manage roles. All of it happens in the real **G2 shell** (sidebar, header, panel, Ctrl K) with G2's motion from day one.

**Architecture:**
- **Infra:** CDK adds a Cognito user pool with a `creators` group, an HTTP API with a JWT authorizer, and one `rooms` Lambda. Data lives in the existing single table.
- **Web:** a new Next.js 16 app (`web/`) that reaches the API **only through a cookie BFF**: httpOnly cookies and `/bff/*` route handlers, copied from instagram-lite step 9. It's styled with Tailwind v4, using G2's tokens as `@theme` variables, and animated with Motion.
- **Local:** runs as `next dev` against Floci. Packaging the site as SSR on Lambda behind CloudFront is deferred to the AWS step; see the Rulings section below.

**Tech Stack:**
- Next.js 16.4.5, React 19, Tailwind CSS v4, `motion` (Motion for React), `cmdk` (command palette), `lucide-react` (stroke icons), `geist` (Geist + Geist Mono fonts), `next/font/google` (Space Grotesk);
- aws-cdk-lib 2.275.0, AWS SDK v3, vitest 5, puppeteer-core (smoke test with the installed Chrome).

**Spec:** `docs/superpowers/specs/2026-11-10-chat-lite-design.md`. The sections that matter here: Rooms, Room-owned permissions, **UI and motion**, Architecture, and step 2 under Proposed steps.

## Global Constraints

- **Everything from step 1 still applies.** Space-safe spawns, stage guards, `cl-<stage>-` names, chat-lite's own Floci, no VPC/NAT/RDS, no CDK custom resources, the secret scan before each commit, and the commit trailer.
- **App role:** create-room is allowed only when the ID token's `cognito:groups` includes `creators`. Membership is granted only by `npm run grant -- <username> creators [--stage=aws]`, run by Aman. Nothing personal goes into the repo or config.
- **Room roles:** `owner` | `admin` | `member`, stored in DynamoDB.
  - The owner is whoever created the room. There is exactly one owner, and the owner can't be removed or demoted.
  - Admins can create chats, rotate or revoke the invite link, and remove members (not admins).
  - Only the owner can make or unmake admins.
- **Invite link:** one active link per room.
  - It's reusable and expires **7 days** after creation (the stored `expiresAt` is checked on every accept; TTL also cleans it up).
  - An admin or the owner can revoke it at any time. Rotating replaces the old link.
  - Accepting makes you a `member`. Accepting a room you're already in is a no-op that sends you into the room.
- **Default chat:** creating a room also creates `#general`.
  - Chat names are lowercase `a-z0-9-`, 1–32 characters, and unique per room.
  - Room names are 1–40 characters.
- **Browser and API:** the browser never sees a token; the patterns are copied from instagram-lite `web/lib/server/*`.
  - Every `/bff/*` mutation checks `Origin` and requires a JSON body.
  - Sign-in returns `ig_`-style cookies renamed `cl_id` and `cl_refresh`.
- **UI:** the G2 tokens, layout and **motion table** from the spec's "UI and motion" section are the bar. Every motion respects `prefers-reduced-motion`. Animate only transform and opacity, except for listed height/width transitions.
  - No percentage progress bars anywhere.
  - Dark only. Every control has hover, focus-visible and active states.
  - No layout shift: reserve space for fonts and icons; `next/font` with `display: swap` and size-adjust.
- **Learn doc:** `docs/learn/02-auth-rooms.md`, plus a study-list row. Stop for Aman's OK; push only after it.

## Review Focus

1. **Privilege escalation through the API:**
   - a non-member reading a room;
   - a member creating a chat or rotating the invite;
   - an admin promoting someone or removing the owner;
   - a non-creator creating a room.

   Each must return 403 from the API, not just be hidden in the UI. Pinned by `access.test.ts` (role matrix) and by `rooms.int.test.ts` calls made with a member's token.
2. **Invite abuse:**
   - an expired link, a revoked link, an unknown code, or a code from a rotated link must be refused;
   - accepting twice must not create two member items or demote an admin back to member.

   Pinned by `invites.test.ts` and `rooms.int.test.ts`.
3. **Concurrent writes:**
   - two "create chat general2" requests at once give one chat and one 409;
   - two accepts by the same user at once give one member item.

   Both use DynamoDB conditional writes or transactions. Pinned in `rooms.int.test.ts` with `Promise.all`.
4. **Token claim shape:** Floci and AWS may format `cognito:groups` differently in the authorizer claims (an array, or a string like `"[creators]"`). `isCreator()` must accept both. Pinned by `claims.test.ts`.
5. **Motion regressions:**
   - `prefers-reduced-motion` must remove animations;
   - switching chats must not shift layout (CLS ≈ 0).

   Pinned by the smoke test: one run with reduced motion emulated, plus a CLS measurement via `PerformanceObserver`.

## Rulings made while planning (from the spec, not from Aman)
- **Deploying the site as SSR on Lambda + CloudFront is deferred** to the first time the site goes on AWS (step 11).
  - Why: instagram-lite step 9 already proved that path, and the construct is reused unchanged. Step 2's risk is auth, roles and the UI bar.
  - Cost if wrong: step 11 grows by about one task.
- **The only real-time thing in step 2** is "your rooms list refreshes after accept or create". Live chat, presence and typing are step 3, so the chat body in step 2 is an honest empty state ("Live chat arrives in step 3"), not fake messages.

---

## File Structure

```
infra/lib/auth.ts(+test)          user pool (email sign-up; local PreSignUp auto-confirm), web client, `creators` group, JWT authorizer
infra/lib/rooms.ts(+test)         rooms Lambda + routes on the HTTP API
infra/lib/core-stack.ts           wires auth + rooms; outputs UserPoolId, UserPoolClientId
services/src/lib/{http,auth,db}.ts  json(), subFromEvent(), parseBody(), claimsFromEvent(), doc client
services/src/auth/presignup.ts    local-only auto-confirm (copy of instagram-lite)
services/src/rooms/
  model.ts(+test)                 validation: roomName(), chatName()
  claims.ts(+test)                isCreator(claims)
  access.ts(+test)                can(action, role) — the role matrix
  invites.ts(+test)               newInviteCode(), inviteState(invite, now)
  repo.ts(+int.test)              DynamoDB items + conditional writes/transactions
  handler.ts(+test)               routes → repo, 4xx mapping
scripts/src/grant.ts(+test)       npm run grant -- <username> <group> [--stage=aws]
scripts/src/deploy-local.ts       also writes web/.env.development.local
scripts/src/smoke.ts              puppeteer end-to-end: two users, room, invite, roles, motion checks
web/ (Next 16 app)
  app/layout.tsx, app/globals.css (Tailwind v4 @theme = G2 tokens)
  app/login/…, app/invite/[code]/…, app/r/[roomId]/…, app/r/[roomId]/c/[chatId]/…, app/page.tsx
  app/bff/auth/{signin,signup,confirm,resend,signout,refresh}, app/bff/api/[...path]
  lib/server/*                    copied from instagram-lite (cookies, csrf, gate, jwt, forward, env, cognito) with cl_ names
  lib/motion.ts                   shared springs/durations (the motion table as constants)
  components/shell/{Sidebar,RoomSwitcher,NavList,Header,Panel,EmptyChat}.tsx
  components/overlays/{CommandPalette,Modal,Toast}.tsx
  components/rooms/{CreateRoom,CreateChat,InvitePanel,MemberList}.tsx
docs/learn/02-auth-rooms.md, docs/learn/README.md
```

## DynamoDB items (single table `cl-<stage>-main`)

| Item | pk | sk | other | gsi1pk / gsi1sk |
|---|---|---|---|---|
| room | `ROOM#<roomId>` | `META` | name, ownerId, createdAt | — |
| member | `ROOM#<roomId>` | `MEMBER#<userId>` | role, username, joinedAt | `USER#<userId>` / `ROOM#<joinedAt>#<roomId>` |
| chat | `ROOM#<roomId>` | `CHAT#<chatId>` | name, createdBy, createdAt | — |
| chat name guard | `ROOM#<roomId>` | `CHATNAME#<name>` | chatId | — |
| room's invite | `ROOM#<roomId>` | `INVITE` | code, expiresAt, createdBy | — |
| invite lookup | `INVITE#<code>` | `META` | roomId, expiresAt, revoked, ttl | — |

IDs come from `crypto.randomUUID()`. Invite codes are 22 base64url characters from `randomBytes(16)`.

## HTTP API (all JWT except where marked)

| Route | Who | Returns |
|---|---|---|
| `GET /me` | any user | `{ userId, username, isCreator }` |
| `GET /rooms` | any user | my rooms `[{ roomId, name, role }]` (gsi1) |
| `POST /rooms` `{name}` | creators | 201 room, with owner member + `#general` (one transaction) |
| `GET /rooms/{roomId}` | member+ | `{ room, me: {role}, chats[], members[] }` |
| `POST /rooms/{roomId}/chats` `{name}` | admin+ | 201 chat; 409 if the name is taken |
| `PATCH /rooms/{roomId}/members/{userId}` `{role}` | owner | `admin` ↔ `member` only |
| `DELETE /rooms/{roomId}/members/{userId}` | admin+ | removes a member; 403 on the owner or on an admin unless the caller is owner |
| `POST /rooms/{roomId}/invite` | admin+ | creates or rotates `{ code, expiresAt }` |
| `GET /rooms/{roomId}/invite` | admin+ | the current link or 404 |
| `DELETE /rooms/{roomId}/invite` | admin+ | revokes it |
| `GET /invites/{code}` (**public**) | anyone | `{ roomName, memberCount, expiresAt }` or 404/410 |
| `POST /invites/{code}/accept` | any user | `{ roomId }`; 410 if expired or revoked |

---

### Task 1: Auth infra, the creators group and the grant script

**Files:**
- Create: `infra/lib/auth.ts`, `services/src/auth/presignup.ts`, `services/src/lib/{http,auth,db}.ts`, `scripts/src/grant.ts`
- Modify: `infra/lib/core-stack.ts`, `scripts/package.json` (`grant` script, `@aws-sdk/client-cognito-identity-provider`), the root `package.json` (`grant`)
- Test: `infra/lib/auth.test.ts`, `services/src/rooms/claims.test.ts`, `scripts/src/grant.test.ts`

**Interfaces:**
- Produces:
  - `addAuth(stack: CoreStack): { userPool, client, authorizer }`. Outputs: `UserPoolId`, `UserPoolClientId`.
  - `isCreator(claims: Record<string, unknown>): boolean`.
  - `grantArgs(argv: string[]): { username: string; group: string; stage: "local" | "aws" }`.
  - `claimsFromEvent(event): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests.**
  - `auth.test.ts` asserts:
    - the user pool `cl-local-users` with a PreSignUp trigger on local and none on aws;
    - email required on aws;
    - a client with `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH`;
    - `AWS::Cognito::UserPoolGroup` named `creators`;
    - one `AWS::ApiGatewayV2::Authorizer` of type JWT.
  - `claims.test.ts`:
    - `isCreator({"cognito:groups": ["creators"]})` is true;
    - `isCreator({"cognito:groups": "[creators admins]"})` is true;
    - `isCreator({"cognito:groups": "creators"})` is true;
    - `isCreator({})` is false;
    - `isCreator({"cognito:groups": ["creatorsX"]})` is false.
  - `grant.test.ts`:
    - `grantArgs(["aman", "creators"])` gives `{username:"aman",group:"creators",stage:"local"}`;
    - `--stage=aws` gives the aws stage;
    - a missing username throws `/usage: npm run grant -- <username> <group>/`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement.
  - The user pool follows instagram-lite's `core-stack.ts` (local PreSignUp auto-confirm; aws email + code); the group is `CfnUserPoolGroup`.
  - **grant:** `AdminAddUserToGroupCommand`. Use `useLocalEnv()` or `useAwsEnv()` by stage, and read the pool ID from that stage's outputs.
  - **Floci check, run it:** deploy, sign up user `t1`, grant `creators`, sign in, then decode the ID token and confirm `cognito:groups` is present. Record what Floci emits in `docs/learn/floci-compat.md` SETUP_NOTES (via `spike-check.ts`). If Floci omits the claim, rule a local fallback: `isCreator` also accepts the env `LOCAL_CREATORS` list on stage local only. Ledger it.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Run `npm run deploy:local`. Expected: outputs include `UserPoolId` and `UserPoolClientId`.
- [ ] **Step 5:** Commit with message `feat(auth): Cognito pool, creators group, JWT authorizer, grant script`.

### Task 2: Rooms domain: validation, role matrix, invites (pure)

**Files:**
- Create: `services/src/rooms/{model,access,invites}.ts`
- Test: `services/src/rooms/{model,access,invites}.test.ts`

**Interfaces:**
- Produces:
  - `roomName(input: unknown): string` (throws `ValidationError`);
  - `chatName(input: unknown): string` (lowercases, trims);
  - `type Role = "owner" | "admin" | "member"`;
  - `type Action = "read" | "createChat" | "manageInvite" | "removeMember" | "setRole"`;
  - `can(action: Action, actor: Role, target?: Role): boolean`;
  - `newInviteCode(): string`;
  - `inviteState(inv: { expiresAt: number; revoked?: boolean } | undefined, nowSec: number): "ok" | "expired" | "revoked" | "missing"`;
  - `INVITE_TTL_SEC = 7 * 24 * 3600`.

- [ ] **Step 1: Write the failing tests.**
  - `model.test.ts`:
    - `chatName(" General ")` is `"general"`;
    - `chatName("a b")`, `chatName("")` and a 33-character name all throw;
    - `roomName("x".repeat(41))` throws.
  - `access.test.ts`: a table-driven matrix over every action × actor × target. It includes:
    - `can("read","member")` is true;
    - `can("createChat","member")` is false;
    - `can("removeMember","admin","member")` is true;
    - `can("removeMember","admin","admin")` is false;
    - `can("removeMember","owner","owner")` is false;
    - `can("setRole","admin","member")` is false;
    - `can("setRole","owner","member")` is true.
  - `invites.test.ts`:
    - the code matches `/^[A-Za-z0-9_-]{22}$/`;
    - 1,000 codes are all unique;
    - `inviteState` returns `ok` before expiry, `expired` at `expiresAt` or later, `revoked` when revoked even before expiry, and `missing` for undefined.
- [ ] **Step 2:** Run `npm -w services test`. Expected: FAIL.
- [ ] **Step 3:** Implement the three modules (pure, no AWS imports).
- [ ] **Step 4:** Run `npm -w services test`. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(rooms): validation, role matrix, invite codes`.

### Task 3: Rooms repo + API on Floci

**Files:**
- Create: `services/src/rooms/{repo,handler}.ts`, `infra/lib/rooms.ts`, `services/vitest.int.config.ts` (copied from instagram-lite, with `TABLE_NAME: "cl-local-main"`)
- Modify: `infra/lib/core-stack.ts` (adds `addRooms(this, auth)`), `services/package.json` (`test:int`)
- Test: `services/src/rooms/handler.test.ts` (repo mocked at its interface), `services/src/rooms/repo.int.test.ts` (Floci), `infra/lib/rooms.test.ts`

**Interfaces:**
- Consumes: Task 1's `isCreator` and `claimsFromEvent`; Task 2's `can`, validators and invite helpers.
- Produces:
  - the HTTP routes in the table above;
  - repo functions `createRoom`, `listMyRooms`, `getRoomView`, `createChat`, `setRole`, `removeMember`, `rotateInvite`, `getInvite`, `revokeInvite`, `previewInvite`, `acceptInvite`;
  - errors map to 400 (validation), 403 (role), 404 (not a member, or no such room; never leak that a room exists), 409 (taken), 410 (expired or revoked).

- [ ] **Step 1: Write the failing tests.**
  - `handler.test.ts`, one test per row of the route table:
    - status codes;
    - a member token on `POST /chats` returns 403;
    - a non-member on `GET /rooms/{id}` returns 404;
    - a non-creator on `POST /rooms` returns 403.
  - `repo.int.test.ts` (Floci table):
    - `createRoom` writes META, the owner MEMBER, `#general` CHAT and the CHATNAME guard;
    - `listMyRooms` returns it with role owner;
    - `Promise.all` of two `createChat(…, "dup")` gives exactly one success and one `Conflict`;
    - the invite flow works: rotate, then accept by user B (member), accept again by B (still one MEMBER item, role unchanged), then an admin-promoted B accepts again and stays admin;
    - an expired invite (expiresAt in the past) gives `Gone`, and a revoked one gives `Gone`;
    - removing the owner throws `Forbidden`.
  - `rooms.test.ts` (infra): every route in the table exists with the JWT authorizer except `GET /invites/{code}`.
- [ ] **Step 2:** Run `npm test` and `npm -w services run test:int` (after `npm run deploy:local`). Expected: FAIL.
- [ ] **Step 3:** Implement the repo with `TransactWriteCommand` for create-room and accept, and `ConditionExpression` for the guards. Then the handler (route switch) and infra (`addFunction("rooms", …)` plus routes).
- [ ] **Step 4:** Both commands from Step 2. Expected: PASS.
- [ ] **Step 5:** Commit with message `feat(rooms): repo + API (roles, chats, invites) on Floci`.

### Task 4: Web foundation: Next 16, Tailwind v4 G2 tokens, Motion, BFF auth, login

**Files:**
- Create: the `web/` app, `web/app/globals.css`, `web/lib/motion.ts`, `web/lib/server/*` (copied and renamed), `web/app/bff/**`, `web/app/login/**`, `web/proxy.ts`, `web/vitest.config.mts`
- Modify: the root `package.json` workspaces (`web`); `scripts/src/deploy-local.ts` (writes `web/.env.development.local`: API_URL, USER_POOL_CLIENT_ID, COGNITO_ENDPOINT, as in instagram-lite)
- Test: copied BFF tests (`cookies`, `csrf`, `gate`, `jwt`, `forward`) adapted to `cl_` names; `web/lib/motion.test.ts`

**Interfaces:**
- Produces:
  - **Tailwind theme tokens:**
    - colours: `ink`, `surface-1`, `surface-2`, `surface-3`, `line`, `line-strong`, `text`, `text-2`, `text-3`, `lime`, `amber`, `sky`;
    - fonts: `font-sans` = Geist, `font-mono` = Geist Mono, `font-display` = Space Grotesk.
  - **Motion constants (`web/lib/motion.ts`):** `spring.glide` `{type:"spring",stiffness:520,damping:38}`, `spring.pop`, `ease.out` `[0.2,0.9,0.2,1]`, `dur.fast` 0.15, `dur.base` 0.3, `dur.slow` 0.45, `useReducedMotionSafe()`.
  - **Server:** `serverApi(path, init?)` (Bearer from cookie) for server components; `/bff/api/*` forwards for client mutations.

- [ ] **Step 1: Write the failing tests.**
  - The copied BFF tests, with names updated: they expect the cookies `cl_id` and `cl_refresh`.
  - `motion.test.ts`: every duration lies between 0.15 and 0.5 (the spec's motion rule), and `useReducedMotionSafe` returns `{ duration: 0 }` transitions when reduced motion is on (mock `matchMedia`).
- [ ] **Step 2:** Run `npm -w web test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Scaffold Next 16.4.5 with the App Router and TypeScript (no `create-next-app` prompts; write the files). Add Tailwind v4 via `@tailwindcss/postcss`.
  - `globals.css` holds `@import "tailwindcss"`, the `@theme` tokens and the scrollbar styles.
  - Copy instagram-lite's server libraries and BFF routes, then rename the cookies.
  - Build `/login` in G2 style: sign in / sign up / confirm code, with a Motion crossfade between modes and inline errors that slide in. `proxy.ts` sends signed-out users to `/login?next=`.
- [ ] **Step 4:** Run `npm -w web test`. Expected: PASS. Then start Floci and run `npm run deploy:local`, then `npm -w web run dev`. Signing up user `t1` should land on `/` with an empty-state "No rooms yet".
- [ ] **Step 5:** Commit with message `feat(web): Next 16 + Tailwind v4 G2 tokens + Motion + cookie BFF + login`.

### Task 5: The G2 shell: sidebar, header, panel, Ctrl K, toasts, modals

**Files:**
- Create: `web/app/page.tsx`, `web/app/r/[roomId]/layout.tsx`, `web/app/r/[roomId]/page.tsx`, `web/app/r/[roomId]/c/[chatId]/page.tsx`, `web/components/shell/*`, `web/components/overlays/*`, `web/components/rooms/{CreateRoom,CreateChat}.tsx`
- Test: `web/components/shell/nav.test.ts` (pure helpers), `web/lib/keys.test.ts`

**Interfaces:**
- Consumes: Task 3's API through `serverApi` and `/bff/api`; Task 4's tokens and motion constants.
- Produces:
  - `navIndex(items, activeId): number` (the highlight position);
  - `direction(prevIndex, nextIndex): "up" | "down"` (the switch transition);
  - `isPaletteShortcut(e: KeyboardEvent): boolean` (Ctrl K or ⌘K, ignored while typing in inputs except the palette's own).

- [ ] **Step 1: Write the failing tests.**
  - `nav.test.ts`: `direction(1,3)` is `"down"` and `direction(3,1)` is `"up"`; `navIndex` returns -1 for an unknown id.
  - `keys.test.ts`:
    - Ctrl K and ⌘K are true;
    - K alone is false;
    - Ctrl K inside a textarea that isn't the palette is false.
- [ ] **Step 2:** Run `npm -w web test`. Expected: FAIL.
- [ ] **Step 3:** Implement the shell exactly per the spec's "UI and motion" section and `docs/design/prototypes/Fluid2.dc.html`.
  - **Sidebar:**
    - a room switcher dropdown that scales in;
    - a Ctrl K button;
    - an "Agent threads" section with an empty state ("Agents arrive in step 4");
    - Chats with a **gliding highlight**: Motion `layoutId` with `spring.glide`;
    - the room budget at `$0.00 / $3`.
  - **Header:** breadcrumb and presence placeholder (avatars of members).
  - **Centre:** the chat empty state, entering in the direction of the switch (`direction()`).
  - **Right panel:** collapsible with a width spring. Tabs are Members and Invite, with the **sliding tab pill**.
  - **Overlays:**
    - Ctrl K uses `cmdk` (backdrop fade, scale-in, cascading rows): jump to a room or chat, create a chat (admin+), copy the invite (admin+);
    - Create room and Create chat are modals;
    - toasts ("Invite link copied", "#deploys created") drop in.
  - **Polish:** new chats slide into the list with a short highlight. Every control has hover, focus-visible and active states.
- [ ] **Step 4:** Run `npm -w web test`. Expected: PASS. Manual check with `npm -w web run dev`:
  - `npm run grant -- t1 creators`, then sign out and in again so the token carries the group;
  - create a room "dev-team" (lands on `#general`), create `#random`;
  - switching chats glides the highlight and slides the content in the right direction;
  - Ctrl K opens the palette;
  - the panel collapses.
- [ ] **Step 5:** Commit with message `feat(web): G2 shell — sidebar glide, directional switch, panel, Ctrl K, toasts`.

### Task 6: Invite and member flows in the UI

**Files:**
- Create: `web/app/invite/[code]/page.tsx`, `web/components/rooms/{InvitePanel,MemberList}.tsx`
- Test: `web/components/rooms/invite.test.ts` (`inviteUrl(origin, code)`, `expiresIn(expiresAt, now)` gives "6 days" / "23 hours" / "expired")

**Interfaces:**
- Consumes: Task 3's invite and member routes.
- Produces: `inviteUrl(origin: string, code: string): string`; `expiresIn(expiresAtSec: number, nowSec: number): string`.

- [ ] **Step 1: Write the failing tests** for `inviteUrl` and `expiresIn`, covering the boundaries: 0 seconds left gives "expired", and 59 minutes gives "59 minutes".
- [ ] **Step 2:** Run `npm -w web test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - **Invite panel (admin+):** create or copy the link with a toast. It shows "expires in 6 days", plus Rotate and Revoke (with a confirm, both animated).
  - **`/invite/[code]`:** a public preview card with the room name, member count and expiry.
    - Signed out: "Sign in to join" goes to `/login?next=/invite/<code>`.
    - Signed in: Join, then a page transition into the room, with the new room sliding into the room switcher.
    - Expired or revoked links get an honest error card.
  - **Members:**
    - role badges for everyone;
    - the owner gets a menu per member: make admin / make member / remove;
    - admins can remove members;
    - row changes animate: a badge cross-fades, a removed row collapses.
- [ ] **Step 4:** Run `npm -w web test`. Expected: PASS. Manual check with two browsers:
  - t1 makes a link;
  - t2 signs up through the link and lands in dev-team as a member;
  - t1 makes t2 an admin;
  - t2 creates `#deploys`;
  - t1 revokes the link, and t3 opening it sees "This link was revoked".
- [ ] **Step 5:** Commit with message `feat(web): invite links + member roles UI`.

### Task 7: End-to-end smoke, motion checks, learn doc

**Files:**
- Create: `scripts/src/smoke.ts` (puppeteer-core, Chrome at the same path as instagram-lite), `docs/learn/02-auth-rooms.md`
- Modify: `scripts/package.json` (`smoke`, `puppeteer-core`), the root `package.json` (`smoke`), `docs/learn/README.md`, `README.md`
- Test: `scripts/src/smoke-helpers.test.ts` (`clsFrom(entries)` sums layout-shift values without recent input)

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run smoke` (exits non-zero on any failed check, and prints a ✅/❌ line per check).

- [ ] **Step 1: Write the failing test** `clsFrom([{value:.05,hadRecentInput:false},{value:.3,hadRecentInput:true}])` is `0.05`.
- [ ] **Step 2:** Run `npm -w scripts test`. Expected: FAIL. Implement it, then run it again. Expected: PASS.
- [ ] **Step 3:** Implement the smoke test against `next dev` and Floci:
  - sign up `s1` and `s2` (auto-confirmed locally), grant `s1` the `creators` group, and sign `s1` in;
  - `s1` creates a room and a chat, and makes an invite;
  - `s2` joins through the invite;
  - via the BFF: `s2` creating a chat gets 403 (Review Focus 1), and a non-creator `s2` creating a room gets 403;
  - `s1` promotes `s2`, then `s2` creating a chat succeeds;
  - `s1` revokes the link, and a fresh accept gets 410;
  - **motion:** switch chats 3 times while measuring CLS, which must be under 0.02. Repeat with `page.emulateMediaFeatures([{name:"prefers-reduced-motion",value:"reduce"}])`: no element may have a running animation 50 ms after the switch (`document.getAnimations()` is empty);
  - `document.cookie` contains no `cl_id`, because it's httpOnly.
- [ ] **Step 4:** Run `npm test` and `npm run smoke`. Expected: all ✅.
- [ ] **Step 5:** Write `02-auth-rooms.md`:
  - Cognito groups vs DB roles;
  - the BFF cookie flow;
  - conditional writes and transactions for the guards;
  - invite link security (unguessable codes, expiry, revocation, rotation);
  - how Motion's `layoutId` makes the glide;
  - "How big companies do it": Slack and Discord invites, Linear's motion, Google Zanzibar-style authorization for the curious.

  Update the study list and README. Run the secret scan, commit with message `docs: step 2 learn doc + smoke`, and **stop for Aman's OK**.
