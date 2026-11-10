# chat-lite study list

One doc per step. Each ends with "How big companies do it" and an interview angle.

| Step | Doc | Study |
|---|---|---|
| 1 | [Skeleton + spikes](01-skeleton-spikes.md) | WebSocket fan-out (`postToConnection`, `GoneException`), SSE + `Last-Event-ID`, durable execution (checkpoint + replay), EventBridge Scheduler, microVM sandboxes (AgentCore) |

Reference: [Floci compatibility report](floci-compat.md) (`npm run spike` / `npm run spike:aws`).
Design: [chat-lite design](../superpowers/specs/2026-11-10-chat-lite-design.md).
