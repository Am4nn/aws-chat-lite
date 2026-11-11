# chat-lite study list

One doc per step. Each ends with "How big companies do it" and an interview angle.

| Step | Doc | Study |
|---|---|---|
| 1 | [Skeleton + spikes](01-skeleton-spikes.md) | WebSocket fan-out (`postToConnection`, `GoneException`), SSE + `Last-Event-ID`, durable execution (checkpoint + replay), EventBridge Scheduler, microVM sandboxes (AgentCore) |
| 2 | [Auth, rooms and the G2 shell](02-auth-rooms.md) | Cognito groups vs per-room roles, one permission function, 404-not-403, conditional writes and transactions for races, invite-link security, the cookie BFF + CSRF, Motion layoutId, reduced motion |
| 3 | [Live people chat](03-live-chat.md) | WebSocket route selection, ticket auth, acks + optimistic UI, per-chat seqs and resume on reconnect, fan-out filtered by membership, heartbeat presence, fixed-window rate limit, soft delete with versions, presigned POST uploads, search by filtered query |

Reference: [Floci compatibility report](floci-compat.md) (`npm run spike` / `npm run spike:aws`).
Design: [chat-lite design](../superpowers/specs/2026-11-10-chat-lite-design.md).
