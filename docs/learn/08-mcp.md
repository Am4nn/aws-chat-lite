# Step 8: MCP both ways

## What we built
- **chat-lite as an MCP client, per room.** In the room panel's Connections tab, owners and admins add up to 5 remote MCP servers by URL (Streamable HTTP, signed in with OAuth, the way Claude.ai connectors work). Each server's tools join the room's agents as `mcp__<name>__<tool>`:
  - a tool the server marks `readOnlyHint` runs freely, unless the thread already holds private content from another source (an attachment, GitHub, the sandbox or another MCP server); then it asks too, because its arguments leave for that server;
  - every other tool waits for a member's Approve on step 7's card, titled `Run <tool> on <name>?`;
  - every MCP tool that ran adds `mcp:<name>` to the thread's taint, so DeepSeek is never offered MCP tools or the threads they touched. The UI shows it as `MCP tool output`.

  Members see each server, its status (`connected`, or amber `needs reconnecting`) and every tool labelled `read-only` or `asks first`. Admins also get `Reconnect`, `Refresh tools` and `Remove`.
- **chat-lite as an MCP server.** `POST /mcp` lets Claude Code, Claude Desktop or Claude.ai sign in as a chat-lite user and use five tools, only in rooms that user belongs to:
  - `list_rooms`, `list_room` and `read_messages` (scope `rooms:read`, marked read-only);
  - `post_message` and `start_thread` (scope `rooms:write`). A post appears under the user's own name, and an `@agent` in it starts a thread, as in the web app.
- **A thin OAuth 2.1 authorization server in front of Cognito** (Lambda `cl-<stage>-oauth`): metadata, dynamic client registration, `authorize`, `token` and `revoke`. Sign-in and consent happen on the web app's new `/consent` page, which already signs in through Cognito.
- **Connected apps** (`/apps`, linked from the sidebar): every app the user let in, with its scopes and last use. `Remove` ends its access at once.
- **A local OAuth MCP test server** (`services/src/mcp/testing/server.ts`, on port 4710 under `npm run dev`). It is the SDK's `Server` plus a hand-written authorization server on `node:http`, with discovery, registration, PKCE, refresh rotation and revocation. Its tools are `echo`, `whoami` and `fail` (read-only) and `add_note` (a write). Unit tests run it in-process; Floci's Lambdas reach it at `http://host.docker.internal:4710`.
- **`npm run smoke`** gained 19 MCP checks (`scripts/src/smoke-mcp.ts`): two browsers on the fake model, plus the SDK's own MCP client playing Claude Code.
  - **As a client:**
    - A adds the test server from the panel, passes its sign-in and lands back on the room with `Connected test`; B, a member, saw `None yet.` and no `Add MCP server`;
    - both see the tools labelled `read-only` / `asks first`, and B gets no buttons;
    - `call:mcp__test__echo` runs without asking and taints the thread with `mcp:test`;
    - `call:mcp__test__add_note` waits: B gets `needs you`, the card `Run add_note on test?`, then Approve;
    - Activity lists the connection, both tool runs and the approval;
    - a stored sign-in that won't open marks the server `needs reconnecting` until A's `Reconnect`;
    - the tool list fades open, and opens at once under reduced motion;
    - the panel fits 390×844;
    - a server that doesn't answer isn't added, and the toast says why (`localhost didn't answer: connect ECONNREFUSED 127.0.0.1:4799`);
    - `Remove` asks, and B sees the row go, `None yet.` and the `disconnected` line.
  - **As a server:**
    - the SDK client is refused, registers, and A's browser reaches `/consent`, whose copy is checked word for word;
    - Allow disables both buttons and returns a code to the client's loopback; the page fits 390×844; Allow on a stale tab shows the expired copy;
    - after the token swap, `tools/list` gives the five tools and `list_rooms` the room;
    - `post_message` shows live on B's page, as A;
    - a signed-out browser goes through `/login` and back to the same request, and Cancel returns `access_denied`;
    - `/consent`, `/apps` and `/login` send the frame headers, and Chrome refuses to frame `/apps`;
    - Connected apps lists `smoke-client` and fits a phone; Remove asks, the row goes at once under reduced motion, and the app's token then gets 401. The SDK client, seeing that 401, tries its refresh token and gets `invalid_grant`, since the grant is gone;
    - a foreign `Origin` on `/mcp` gets 403, `GET` 405 with `Allow: POST`, no token 401 with `resource_metadata`;
    - 20 registrations get 201 and the 21st 429 `slow_down`.

  The smoke found that a framed `/consent` wasn't safe after all. A signed-out visitor is redirected to `/login`, which had no frame headers, so another site could show chat-lite's sign-in form inside its own page. Every page now sends `frame-ancestors 'none'` and `X-Frame-Options: DENY` (the app never frames itself).

## How to try it
```powershell
npm run deploy:local       # fake models; MCP_LOCAL_HOSTS lets the Lambdas reach host.docker.internal
npm run dev                # the web app, the run stream, the sandbox server and the MCP test server on 4710
```
- **Connect a server:** open a room, then Connections, then `Add MCP server`. Name it `test` and give it `http://host.docker.internal:4710/mcp`. The test server signs you in at once and sends you back with `Connected test`. Then ask `@agent go call:mcp__test__add_note` and approve it.
- **Use chat-lite from Claude Code** (by hand; agents don't run this): `claude mcp add --transport http chat-lite <McpBaseUrl>/mcp`, where `McpBaseUrl` is in `infra/cdk.out/outputs-local.json` (`http://<apiId>.execute-api.localhost.floci.io:4566`). Claude Code finds the sign-in from the 401, registers itself and opens `http://localhost:3000/consent?request=…` in the browser. After Allow, `/mcp` in Claude Code lists chat-lite's five tools.

## How the two OAuth flows run
```mermaid
sequenceDiagram
  participant A as admin's browser
  participant W as web BFF
  participant C as cl-local-mcp-connections
  participant S as remote MCP server + its AS
  A->>W: Add MCP server {name, url}
  W->>C: POST /rooms/{id}/connections/mcp
  C->>S: POST /mcp (no token) → 401 + resource_metadata
  C->>S: PRM, AS metadata, POST /register (DCR)
  C->>C: PKCE verifier; MCPFLOW#<state> {admin, pending (sealed)} ttl 600 s
  C-->>A: authorizeUrl
  A->>S: /authorize?code_challenge&state
  S-->>A: 302 /bff/mcp/callback?code&state
  A->>W: callback (the admin's own session cookie)
  W->>C: POST /mcp-flows/finish {state, code}
  C->>C: take the flow (one delete), same admin?
  C->>S: POST /token (code + verifier + resource)
  C->>S: tools/list → snapshot
  C->>C: CONN#mcp#<name> + MCPAUTH#<name> (sealed) + audit, one transaction
  C-->>W: {roomId, connection}
  W-->>A: 303 /r/{id}?mcp=<name> → "Connected <name>"
```
The other direction has the same shape with the parts swapped: Claude Code is the client, `cl-<stage>-oauth` is the authorization server, and `/consent` is where the user signs in and allows it.

## The patterns
**MCP Streamable HTTP, stateless and in JSON mode.** An MCP client sends JSON-RPC requests with `POST` to one URL. The server may answer as a JSON body or as an SSE stream, and it may hand out an `Mcp-Session-Id` so that later requests (and a `GET` stream for server-initiated messages) land on the same session. On Lambda, a session would have to live somewhere, and no two requests are sure to reach the same instance. So `/mcp` runs with sessions off (`sessionIdGenerator: undefined`) and `enableJsonResponse: true`:
- each POST builds a fresh SDK `Server` and `WebStandardStreamableHTTPServerTransport`, answers, and is gone;
- `GET` and `DELETE` get 405 with `Allow: POST`;
- every request carries its own bearer token, checked by one `GetItem`.

Nothing chat-lite's tools do needs a server-to-client message, so nothing is lost.

**OAuth 2.1 for MCP: the five documents and parameters.**
1. **Protected-resource metadata (RFC 9728).** A 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`. That document names the resource and its authorization servers.
2. **Authorization-server metadata (RFC 8414)** at `/.well-known/oauth-authorization-server`: the endpoints, `S256`, and `token_endpoint_auth_methods_supported: ["none"]`.
3. **Dynamic client registration (RFC 7591).** A client the server has never seen registers its name and redirect URIs, and gets a `client_id`.
4. **PKCE (S256).** The client keeps a random verifier and sends only its SHA-256 at authorize. A stolen code is useless without the verifier, which is why public clients (no secret) are safe here.
5. **Resource indicators (RFC 8707).** `resource=<base>/mcp` at authorize and token binds the token to our MCP endpoint. A token meant for another server can't be replayed here, and ours can't be replayed there.

Both of our sides speak all five. The client side uses the SDK's helpers (`discoverOAuthServerInfo`, `registerClient`, `startAuthorization`, `exchangeAuthorization`, `refreshAuthorization`) server-side, never in the browser.

**A thin authorization server in front of an IdP that lacks DCR.** Cognito can't register clients on the fly, and MCP clients expect to. So chat-lite runs its own small authorization server for MCP only, and leaves the people to Cognito:
- `/oauth/authorize` validates the client, redirect URI, PKCE and resource, stores an `OAUTHREQ#<id>` for 10 minutes, and redirects to `/consent?request=<id>`;
- the consent page signs the user in with the existing Cognito session (or sends them through `/login` and back), shows what the app asks for, and posts the decision;
- `allow` mints a 60-second code and redirects to the client's registered URI.

Rules worth knowing:
- every client is public (`none` + PKCE); a requested secret method is replaced in the response, as RFC 7591 allows;
- redirect URIs are `https:`, or `http:` on a loopback host where any port matches (RFC 8252 §7.3, for desktop apps that pick a free port);
- every authorize fault is a 400 error page, never a redirect: an unknown client or redirect URI, and also a bad `response_type`, PKCE or `resource` from a registered one. Under DCR anyone can register any https URI, so redirecting even a known client's errors would make the endpoint an open redirector, which RFC 9700 §4.11.2 forbids for untrusted URIs;
- per source IP and hour, `register` gets 20 and `authorize` 60, then 429 `{"error":"slow_down"}`.

**Least privilege on a single table: `dynamodb:LeadingKeys`.** `cl-<stage>-oauth` is public and unauthenticated, so it doesn't get the read/write on the whole table the other Lambdas have. Its policy allows `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` and `ConditionCheckItem` only where every partition key matches `OAUTHCLIENT#*`, `OAUTHREQ#*`, `OAUTHCODE#*`, `OAUTHGRANT#*` or `RATE#oauth#*` (`ForAllValues:StringLike` on `dynamodb:LeadingKeys`, plus a `Null: false` check, since `ForAllValues` over a missing key is true). The `Query` on `gsi1` is unconditioned: `LeadingKeys` doesn't reliably cover an index's key, and that index is only read here. A bug in the authorization server then can't read rooms or messages through the table.

**Opaque tokens, hashed, on one grant item.** chat-lite's tokens are random strings (`cl_at_<grantId>_<43 chars>`, `cl_rt_…`, `cl_code_…`), not JWTs. Only their SHA-256 hashes are stored, all on one `OAUTHGRANT#<grantId>` item (access hash, its expiry, refresh hash, scopes, user). The trade-off:
- **for:** revoking an app is deleting one item, effective on the next request. A leaked table holds no usable token;
- **against:** every MCP request costs one `GetItem`, and no other service can verify the token offline. We have one resource server, so offline verification buys nothing.

**Refresh rotation with reuse detection, and the race it causes.** Every refresh returns a new refresh token and retires the old one. Presenting a retired one means two parties hold the same token, so the server revokes the whole grant (OAuth 2.1's advice for public clients); the same goes for a code used twice.
- **The catch on our client side.** Two runs in one room may refresh the same expired token at once. The loser presents a token the winner just rotated, and gets `invalid_grant` (or, on a strict server, the grant dies).
- **The rule.** `withFreshAuth` reloads the stored tokens on `invalid_grant`. Only if the version is unchanged (after a 0.5 s grace, because the winner's save may still be in flight) does it mark the connection `needs_auth`. The store's `save` is conditional on the version it read, so the loser can't write over the winner. There is no lock.
- **The same race on our own server.** Claude Code can refresh twice at once too, so the grant keeps the previous refresh hash and when it was replaced (`prevRefreshHash`, `rotatedAt`). A token replaced within the last 30 s gets `invalid_grant` without a revoke: that is a race, not theft. Later than that, it revokes as above. A rotation write that loses its condition (or a `TransactionConflict`) doesn't revoke either.
- **The person behind the grant.** Each refresh asks Cognito (`AdminGetUser`). A deleted or disabled account's grant is deleted there, so its app is out within the access token's hour instead of sliding on for 30 days at a time.

**OAuth CSRF, and binding the callback to the initiator.** The `state` parameter stops a forged callback, but only if the callback checks who is finishing. Ours goes through the BFF (`/bff/mcp/callback`) with the admin's own session:
- the flow item `MCPFLOW#<state>` records the admin who started it, and is taken with one conditional `DeleteItem`, so it is used once even when the user check then fails;
- a link carrying someone else's code, opened by another member, is refused with `Finish connecting as the admin who started it.`, and that flow is gone;
- a state used twice reads `This connection attempt expired. Try again.`.

**Sealing tokens at rest: AES-256-GCM with AAD.** A remote server's tokens sit in `ROOM#<id> / MCPAUTH#<name>` as one sealed blob.
- **The key.** It is derived with HKDF-SHA256 from a CloudFormation-generated secret, `cl-<stage>-token-key`. It is never in a Lambda's environment.
- **The AAD.** It is the room and the name, so a blob copied into another room's item fails authentication and the connection reads `needs reconnecting`.
- **The pending flow.** The PKCE verifier and the client registration are sealed the same way, with `state` as the AAD.
- **The next step: envelope encryption with KMS.** Each blob gets its own data key, encrypted by a KMS key that never leaves KMS, so decrypting needs IAM permission and leaves a CloudTrail record. That costs $1 a month per key; for now one leaked secret would open every room's tokens.

**SSRF on user-supplied URLs, checked at connect time with no auto-follow.** An admin types the server URL, and the server's metadata then supplies more URLs (token, registration, authorize). A hostile server could point any of them inside the network. So every outbound request (discovery, registration, token, revoke, MCP calls) goes through one `guardedFetch`:
- `https:` only, no userinfo, at most 500 characters, no key-like query parameter (`Don't put keys in the URL: chat-lite signs in with OAuth.`);
- every resolved address is checked inside the socket's `lookup`, and an IP literal is checked before any lookup runs;
- redirects are never followed (a 302 to `http://127.0.0.1/` is an error, not a request);
- each answer may be at most 2 MB, with a 10 s deadline (60 s for a tool call);
- the browser-bound `authorization_endpoint` follows the same scheme rule, so `javascript:` never reaches `location.assign`;
- a remote's error reaches a run or a toast as one short line: an OAuth error by its code, an HTTP error by its status, an unreadable answer by fixed copy, anything else cut at 200 characters. Error bodies can quote what we sent (a refresh token, the bearer) and run to 2 MB, more than a run event's DynamoDB item holds.

The only exception is `MCP_LOCAL_HOSTS`, set on the local stage only (an infra test pins it absent on aws), so Floci can reach the test server over `http:`.

**Tool annotations are hints from the server, so the list is pinned.** `readOnlyHint` decides whether a call asks first, and a server could lie about it, or change it later:
- **rug pull:** connect with an innocent tool list, then swap in new tools or flip a write to read-only;
- **tool poisoning:** instructions hidden in a tool's description.

Our defences:
- **The snapshot.** The tool list is the one the admin saw at connect time, at most 40 tools, each description cut to 1,000 characters and any schema over 10,000 characters dropped, and it stops before 300 KB so it fits its DynamoDB item. New tools wait for `Refresh tools`.
- **Names checked.** A name outside the MCP spec's `^[A-Za-z0-9_.-]{1,128}$` is dropped, and only the first tool per `mcp__<name>__<tool>` is kept: `a.b` and `a_b` map to the same name, and one duplicate name makes the model API refuse every turn in the room. The approval card only ever shows a name that passed.
- **No free pass for writes.** A call to a tool not in the snapshot is unknown, and anything without `readOnlyHint: true` asks.
- **What can still go wrong.** A server that lies at connect time still gets its write run unasked. The admin saw `read-only` beside it when connecting.

**The confused deputy: our MCP server never forwards its token.** A confused deputy is a server that holds authority from one party and uses it for another. Here:
- `/mcp` acts only as the user whose token it got, and its tools call chat-lite's own repos directly;
- no tool takes a URL, and the token is never passed to another service;
- the remote servers we call as a client get only the token they issued themselves (bound by `resource`).

Membership is checked again on every call, so someone removed from a room loses it on their next request, whatever their token says.

## Rulings
| Ruling | Cost if wrong |
|---|---|
| Authorize lives on the API and hands sign-in and consent to the web app's `/consent`; Cognito's hosted UI is never used | One extra redirect; `/consent`, and `/login` behind it, must stay frame-proof |
| Every page sends `frame-ancestors 'none'` + `X-Frame-Options: DENY`, not only `/consent` and `/apps` | A later feature that frames the app (an embed) needs its own path exempted |
| Opaque tokens, hashed on one grant item; no JWTs | One `GetItem` per MCP request; no offline verification |
| DCR only, both ways; no Client ID Metadata Documents | Servers that accept only CIMD or pre-registered clients can't be connected, and CIMD-only clients can't connect to us |
| Every authorize fault is an error page, even with a registered redirect URI | A client sees our error page instead of its own `error=` callback |
| A read-only MCP call asks first when the thread holds private content from any other source; taint is per server (`mcp:<name>`) | A server can echo its own earlier output back to itself unasked (no new exposure) |
| A refresh token replaced within 30 s is `invalid_grant` without a revoke | A thief who replays within 30 s of the real client's refresh is refused but doesn't end the grant |
| A refresh asks Cognito whether the account still exists and is enabled; access tokens aren't re-checked | A deleted account's app keeps its access token for up to an hour |
| The OAuth Lambda's table access is limited by `dynamodb:LeadingKeys`; its `gsi1` query is unconditioned | It can read memberships and grant hashes through the index |
| Every chat-lite client is public (`none` + PKCE) | A client that ignores the response and sends a secret gets `invalid_client` |
| Two scopes, `rooms:read` and `rooms:write`; a read-only token doesn't see the write tools | Per-room scopes would need a room picker on consent |
| Posts made over MCP appear as the user, with no "via app" label | Members can't tell a person from their Claude Code |
| The tool list is a snapshot admins refresh by hand; `readOnlyHint` comes from it; no audit entry for a refresh | A server's new tools wait for `Refresh tools`, and a lying server's write runs unasked |
| At most 40 tools per server and 5 servers per room; no per-run total | A 200-tool room costs about 30k input tokens on a run's first call |
| Remote tokens sealed with AES-256-GCM under an HKDF key from a generated secret, not KMS | One leaked secret opens every room's tokens |
| No refresh lock: a version check plus "reload on `invalid_grant`" with a 0.5 s grace | A server that revokes the family on reuse forces a reconnect (both runs must refresh within one round trip); a truly revoked connection reports 0.5 s later |
| The OAuth callback goes through the BFF, so the finisher must be the signed-in admin who started | An admin whose session expires mid-flow starts again |
| `MCP_LOCAL_HOSTS` only on the local stage | A misconfigured aws deploy would allow private hosts: an infra test pins it absent |
| No CORS on the OAuth and MCP endpoints, and a foreign `Origin` on `/mcp` gets 403 | Browser-only MCP clients can't connect |
| `start_thread` takes no model; the room default answers | Picking a model from Claude Code is a later field |
| A used, expired or unknown consent request is a 404 on both the read and the decision | None: the page shows the expired copy either way |
| A failed token check (wrong verifier, redirect or resource) doesn't burn the code; a code used twice revokes the grant it made | A stolen code can be retried for its 60 s life; PKCE makes that useless |

## npm dependencies added
- **`@modelcontextprotocol/sdk@^1.32.2`** in `services` and `scripts`, the official TypeScript SDK:
  - **services:** the low-level `Server` and `WebStandardStreamableHTTPServerTransport` behind `/mcp`; the `Client`, `StreamableHTTPClientTransport` and OAuth helpers for remote servers; the test server;
  - **scripts:** the smoke's MCP client, which signs in to chat-lite the way Claude Code does.

  It brings `zod` as a peer, which our code never imports.
- Everything else is `node:crypto` (AES-GCM, HKDF, SHA-256), `node:http(s)` and `node:dns`.

## The live run
One Sonnet thread on Floci (`deploy:local -- --live-models`, 2026-11-11), with the test server connected as `test`: `use the test MCP server: echo "hello", then save a note "from chat-lite"`.
- **Tool names.** Sonnet used `mcp__test__echo` and `mcp__test__add_note` as offered, with the right inputs (`{"text":"hello"}`, `{"text":"from chat-lite"}`), and no schema surprises. The test server logged both calls, as the signed-in `tester`.
- **The gate.** The echo ran at once; the note waited for Approve (`Run add_note on test?`); the thread ended private (`mcp` taint).
- **The bug it found.** Sonnet asked for both tools in **one turn**. The run executes a turn's calls one step at a time, so the note's step started after the echo's result was logged. Rebuilding the context from the event log, a tool result ended the assistant message, so the note's call opened a second one. The replayed native turn then carried a `tool_use` with no result right after it, the API refused every retry, and the run failed with "The agent hit an error." The fake model only ever calls one tool per turn, so no fake run could show it. The fix: `buildContext` keeps a native turn's later calls on that turn's message, so all its results follow it (pinned in `runs/context.test.ts`). The second live run answered: "I ran both calls on the test MCP server: Echo: the server returned `echo: hello`. Note: it saved "from chat-lite" as note #1."
- **Spend:** $0.0111 for the two threads ($0.0045 for the failed one, $0.0065 for the one that passed).

## Floci notes
- **Public `/.well-known/` routes work on Floci's HTTP API.** All three metadata paths reach the OAuth Lambda, so the issuer is the API's own host (`http://<apiId>.execute-api.localhost.floci.io:4566`) with no local substitute.
- **Bodies arrive as on AWS.** A form-encoded body (`/oauth/token`, `/oauth/revoke`) reaches the Lambda base64-encoded with `isBase64Encoded: true`, and a JSON body as plain text.
- **The token key.** Floci's CloudFormation honours `GenerateSecretString` (64 letters and digits). A Floci reset makes a new key, so every stored MCP sign-in becomes unopenable and reads as `needs reconnecting`. The smoke uses exactly that to check `Reconnect`.
- **DynamoDB runs the token store's writes as written:** `ADD #version` inside a transaction, the conditional save on `#version`, and a `DeleteItem` with `ReturnValues: ALL_OLD` under a TTL condition.
- **`host.docker.internal`.** From Floci's Lambdas it reaches the test server, which binds `127.0.0.1` only. From the host it resolves to the LAN address, so tests on the host map it to 127.0.0.1 with a `lookup`.
- **Cognito's `AdminGetUser` works from Floci's Lambdas.** A deployed refresh keeps an enabled account's grant and drops a disabled one's (pinned in `mcp/server/mcp.int.test.ts`), so no local substitute is needed.
- **IAM isn't enforced,** so the OAuth Lambda's `LeadingKeys` scope can't be seen working locally.
- **The rate limit counts Floci's source IP,** which is the same for every caller on this machine, so the smoke clears the `RATE#oauth#…` items before it counts to 21.
- Details are in the [Floci compatibility report](floci-compat.md).

## Known limits
- **Behind CloudFront (step 11):**
  - `requestContext.http.sourceIp` is CloudFront's edge address, so the per-IP limits on `register` and `authorize` would count the edge, not the viewer. The limit must read the viewer address (`CloudFront-Viewer-Address`, forwarded by an origin request policy), or a WAF rate rule must replace it;
  - CloudFront must route `/mcp`, `/oauth/*` and `/.well-known/oauth-*` to the API origin, uncached and with `Authorization` forwarded. `MCP_BASE_URL` on aws is `https://chat.amanarya.com`, so the metadata documents name the CloudFront host.
- **No Client ID Metadata Documents,** the MCP spec's newer alternative to DCR. A client that only offers a metadata URL as its `client_id` is refused.
- **No server-to-client messages:** no sessions means no `GET` stream, so a remote server's progress notifications and sampling requests aren't supported, in either direction.
- **The snapshot can't catch a server that lies at connect time** (see the annotations pattern).
- **Tokens sealed with one derived key,** not per-item KMS data keys.
- **MCP tools only for `privateOk` models,** so a room on DeepSeek has none.
- **A second 401 in one call** reads `<name> didn't answer: Unauthorized` rather than the reconnect copy.
- **The `?mcp=` / `?mcpError=` toast shows only in a tab that started a flow.** The panel sets a `sessionStorage` mark before it leaves for the remote's sign-in, and the room shows the toast only when the mark is there, then clears it. A crafted link opens the room with no toast. A tab that started a flow and never came back could still show one from a crafted link (text only, so spoofing, not XSS).
- **`dynamodb:LeadingKeys` isn't checked on Floci,** which enforces no IAM; an infra test pins the policy until the aws deploy shows it working.

## How big companies do it
- **Claude.ai connectors:** a user or an org admin adds a remote MCP server by URL; Claude.ai runs discovery, DCR and PKCE server-side, keeps the tokens, and shows each tool's read or write permission, with "always allow" per tool. Our rooms work the same way, minus "always allow".
- **Cloudflare `workers-oauth-provider`:** a library that wraps a Worker in an OAuth 2.1 provider for MCP. It stores only token hashes, encrypts the grant's props with a key derived from the token itself, and hands the consent screen to the app. It is the same thin-AS-in-front-of-your-own-login pattern.
- **GitHub's remote MCP server:** OAuth through a GitHub App or a personal token, with toolsets you switch on, and read-only mode as a flag. The scope decides which tools are listed, as our two scopes do.
- **Auth0, WorkOS, Stytch, Descope for MCP auth:** hosted authorization servers that add DCR and the MCP metadata in front of an existing user directory, which is our `cl-<stage>-oauth` as a product.
- **Okta Cross App Access (ID-JAG):** the enterprise IdP issues a token that lets one app (an agent) reach another on the user's behalf without a consent screen per app, with the admin's policy deciding. It is the answer to "a hundred agents, each with its own consent flow".
- **Client ID Metadata Documents:** the client's `client_id` is an https URL of a JSON document describing it, so the server needs no registration endpoint and can show a verified host on consent. Our consent page has to say "chat-lite hasn't checked who made this app" because DCR proves nothing about the client.

## Interview angle
- "How would you let Claude Code use your app?" Expose an MCP endpoint over Streamable HTTP, stateless if it runs on Lambda. Protect it with OAuth 2.1: protected-resource metadata on the 401, AS metadata, DCR, PKCE S256 and a resource indicator. Sign the people in with the IdP you already have.
- "JWT or opaque token?" Opaque with a hashed lookup when you have one resource server and want instant revocation; JWTs when many services must verify offline and you accept revocation lag or a deny list.
- "What can go wrong with refresh-token rotation?" Two workers refreshing at once look like token theft to the server. Store tokens with a version, save conditionally, and on `invalid_grant` reload before you give up.
- "How do you keep a third-party server from steering your backend?" Treat every URL it sends as hostile: check resolved addresses at connect time, never auto-follow redirects, cap size and time, and validate the browser-bound URL's scheme.
- "Why is `readOnlyHint` not a security boundary?" It is the server's claim. Pin the tool list the admin approved, ask first for anything not marked read-only, and taint whatever the output touches.
