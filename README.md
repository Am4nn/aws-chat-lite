# chat-lite

Team rooms where people and their own shared AI agents work side by side, built the way AI chat
platforms are built (WebSockets, resumable SSE, agent loop, MCP, sandboxes, budgets) on serverless AWS.
A learning project, sibling of [aws-instagram-lite](https://github.com/Am4nn/aws-instagram-lite).

**Status:** step 1 of 11 (skeleton + spikes). Design: [docs/superpowers/specs/2026-11-10-chat-lite-design.md](docs/superpowers/specs/2026-11-10-chat-lite-design.md).
**Start here:** [docs/learn/README.md](docs/learn/README.md).

## Run locally
```powershell
# once (Docker Desktop running)
npm install
npm run floci:up          # chat-lite's own local AWS (only one project's Floci at a time)
npm run deploy:local      # core stack on Floci; prints a curl for /health
```

## Check it
```powershell
npm test                  # unit + template tests
npm run spike             # probes on Floci → docs/learn/floci-compat.md
npm run spike:aws         # same on real AWS (Sydney) + AgentCore sandbox; deploys and destroys a throwaway stack
```

## Layout
- `infra/`: CDK app (`lib/core-stack.ts`, `lib/spike-stack.ts`)
- `services/`: Lambda handlers
- `scripts/`: Floci, deploy, spike tools
- `docs/learn/`: one doc per step + the Floci compatibility report
