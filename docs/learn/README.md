# chat-lite study list

One doc per step. Each ends with "How big companies do it" and an interview angle.

| Step | Doc | Study |
|---|---|---|
| 1 | [Skeleton + spikes](01-skeleton-spikes.md) | WebSocket fan-out (`postToConnection`, `GoneException`), SSE + `Last-Event-ID`, durable execution (checkpoint + replay), EventBridge Scheduler, microVM sandboxes (AgentCore) |
| 2 | [Auth, rooms and the G2 shell](02-auth-rooms.md) | Cognito groups vs per-room roles, one permission function, 404-not-403, conditional writes and transactions for races, invite-link security, the cookie BFF + CSRF, Motion layoutId, reduced motion |
| 3 | [Live people chat](03-live-chat.md) | WebSocket route selection, ticket auth, acks + optimistic UI, per-chat seqs and resume on reconnect, fan-out filtered by membership, heartbeat presence, fixed-window rate limit, soft delete with versions, presigned POST uploads, search by filtered query |
| 4 | [Agent threads (fake model)](04-agent-threads.md) | Durable execution (checkpoint, replay, determinism), a single-writer event log, resumable SSE (`Last-Event-ID`, the 15-minute limit, poll vs push), signal vs data channel, the inbox cursor and atomic close, cooperative cancellation, pre-call budget checks in integer micro-dollars, atomic counters, name guard items, archive computed on read, a model gateway |
| 5 | [Model gateway (real models)](05-model-gateway.md) | A provider-agnostic gateway with one meter, routing with a cheap classifier and a safe default, data-classification taint enforced where data leaves, replaying native turns (thinking signatures), prompt caching as a prefix match, retry only what wrote nothing, secrets from Secrets Manager with a per-container cache, load testing a fan-out system |

Reference: [Floci compatibility report](floci-compat.md) (`npm run spike` / `npm run spike:aws`).
Design: [chat-lite design](../superpowers/specs/2026-11-10-chat-lite-design.md).
