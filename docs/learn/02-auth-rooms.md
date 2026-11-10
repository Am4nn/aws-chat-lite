# Step 2: Auth, rooms and the G2 shell

## What we built
- **Sign-up and sign-in with Cognito,** behind a cookie BFF. The browser never sees a token: the Next.js server keeps them in httpOnly cookies and calls the API for you.
- **Two kinds of permission:**
  - an **app role**: the Cognito group `creators`, who may create rooms;
  - **room roles**: owner, admin or member, stored per room in DynamoDB.
- **Rooms and people chats**, with an invite link per room that is reusable, expires after 7 days, can be revoked, and gets replaced when rotated.
- **The real G2 shell:**
  - the sidebar's gliding highlight, and content that slides in from the direction you moved;
  - the collapsible room panel with a sliding tab pill, and the Ctrl K palette;
  - toasts and modals;
  - all of it respects reduced motion.
- **`npm run smoke`:** an end-to-end browser test of all of the above, including checks that the API really returns 403.

## How a request flows
```mermaid
sequenceDiagram
  participant B as Browser
  participant N as Next.js server (BFF)
  participant C as Cognito
  participant A as HTTP API (JWT authorizer)
  participant L as rooms Lambda
  participant D as DynamoDB
  B->>N: POST /bff/auth/signin {username, password}
  N->>C: InitiateAuth (USER_PASSWORD_AUTH)
  C-->>N: ID token + refresh token
  N-->>B: Set-Cookie cl_id (httpOnly), cl_refresh (httpOnly, /bff/auth only)
  B->>N: POST /bff/api/rooms/r1/chats {name} (cookie rides along)
  N->>A: POST /rooms/r1/chats, Authorization: Bearer <ID token>
  A->>A: verify signature, issuer, audience, expiry
  A->>L: event with claims (sub, cognito:groups)
  L->>D: read MEMBER item → role; can("createChat", role)?
  L->>D: TransactWrite [CHATNAME guard (must not exist), CHAT]
  L-->>B: 201 (or 403 / 409)
```

## The ideas, in plain words
- **App role vs room role:**
  - "Who may create rooms" is the same everywhere, so it lives in the identity provider as a **group**. It arrives inside every token, and checking it needs no database read.
  - "Who may manage this room" differs per room, so it lives **with the data**: one `MEMBER#<user>` item per person per room, holding the role.
  - Mixing the two up is a classic mistake: you end up with either a giant token or a database read for every global check.
- **One function decides permissions:** `can(action, actorRole, targetRole)` in `services/src/rooms/access.ts`.
  - A table-driven test covers every combination.
  - The UI hides buttons you can't use, but only the server's check counts. The smoke test calls the API directly as a member to prove the 403s.
- **Never reveal what you can't see:** a non-member asking for a room gets **404, not 403**, so they can't even learn that the room exists.
- **Concurrency without locks:** DynamoDB **conditional writes** and **transactions** do the work.
  - Each chat name has a guard item (`CHATNAME#deploys`) written with `attribute_not_exists`. If two people create `#deploys` at the same moment, exactly one write succeeds and the other gets 409.
  - The integration test fires both requests in parallel to prove it.
  - Accepting an invite twice is a no-op for the same reason: the member item is written only if it doesn't exist.
- **Invite links:**
  - The code is 128 random bits (22 URL-safe characters), so it can't be guessed.
  - The **server** checks its expiry on every accept, because DynamoDB's TTL deletes items lazily, sometimes days later.
  - Rotating marks the old link revoked in the same transaction that creates the new one, so there's never a moment with two live links.
  - That transaction is also **optimistically locked**: it only applies if the room still points at the code it read. Without the lock, two admins rotating at the same instant would both revoke the same old code, and one new code would stay live for a week with nothing pointing at it. The loser gets a 409 and simply tries again. Revoke uses the same check.
- **The cookie BFF:**
  - `cl_id` (the ID token) is httpOnly and SameSite=Lax.
  - `cl_refresh` is httpOnly and only sent to `/bff/auth/*`, so the long-lived credential isn't attached to every request.
  - Every write through `/bff/*` must come from our own Origin and carry a JSON body. That's the standard CSRF pair.
- **The gliding highlight:** Motion's `layoutId`. The active row renders an element with the same `layoutId`, and when it moves to another row, Motion animates it from the old position to the new one with a spring.
- **Reduced motion:** `<MotionConfig reducedMotion="user">` switches off transform animations for people who ask their OS for less motion. Entering content also starts in place, so not a single frame is offset. The smoke test measures this frame by frame.

## How big companies do it
- **Auth:**
  - Most products put tokens in httpOnly cookies behind their own domain (a BFF or session gateway) instead of in `localStorage`, exactly as here.
  - Auth0 and Okta call this the "token handler" pattern, and Vercel's and Clerk's Next.js integrations work this way too.
- **Roles:**
  - Slack's workspace roles and Discord's server roles are per-community, stored with the community.
  - Global capabilities, like staff tools, come from the identity layer.
  - At scale, permissions become a separate service. Google's **Zanzibar** (and open-source descendants like SpiceDB and OpenFGA) store relations like "user U is admin of room R" and answer "can U do X on R?" in milliseconds.
- **Invites:**
  - Discord invites have codes, expiry, a max-uses limit and revocation.
  - Slack's shared links expire and can be deactivated.
  - Same building blocks.
- **Motion:**
  - Linear, Vercel and Arc treat motion as part of the product. They use shared-element transitions (`layoutId`), springs instead of fixed durations, and they test reduced-motion paths.

## Interview angle
- "How do you stop two users creating the same name at once?" A unique guard item with a conditional write (or a unique index), never a read-then-write.
- "Where do you keep tokens in a web app, and why?" In httpOnly cookies through a BFF; it shrinks the damage an XSS can do. Add CSRF defences: SameSite, an Origin check and JSON-only writes.
- "How do you design roles for a multi-tenant app?" Coarse global roles in the identity provider, per-tenant roles with the tenant's data, and one decision function. Zanzibar-style systems are the large-scale version.

## Poke it
```powershell
npm run floci:up; npm run deploy:local       # API + Cognito on Floci, writes web/.env.development.local
npm run dev                                  # http://localhost:3000, then sign up
npm run grant -- <your-username> creators    # then sign out and in again to create rooms
npm run smoke                                # end-to-end check (needs npm run dev running)
npm -w services run test:int                 # DynamoDB race and invite tests on Floci
```
