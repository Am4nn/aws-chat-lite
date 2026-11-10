# chat-lite

Team rooms where people and their own shared AI agents work side by side, built the way AI chat
platforms are built (WebSockets, resumable SSE, agent loop, MCP, sandboxes, budgets) on serverless AWS.
A learning project, sibling of [aws-instagram-lite](https://github.com/Am4nn/aws-instagram-lite).

**Status:** step 2 of 11 (auth, rooms, invites and the G2 shell). Design: [docs/superpowers/specs/2026-11-10-chat-lite-design.md](docs/superpowers/specs/2026-11-10-chat-lite-design.md).
**Start here:** [docs/learn/README.md](docs/learn/README.md).

## Run locally
```powershell
# once (Docker Desktop running)
npm install
npm run floci:up          # chat-lite's own local AWS (only one project's Floci at a time)
npm run deploy:local      # API + Cognito on Floci; writes web/.env.development.local
npm run dev               # the app at http://localhost:3000
npm run grant -- <username> creators   # let that user create rooms (sign out and in again)
```

## Check it
```powershell
npm test                  # unit + template tests
npm -w services run test:int   # DynamoDB integration tests on Floci
npm run smoke             # end-to-end in Chrome (needs npm run dev)
npm run spike             # probes on Floci → docs/learn/floci-compat.md
npm run spike:aws         # same on real AWS (Sydney) + AgentCore sandbox; deploys and destroys a throwaway stack
```

## Layout
- `infra/`: CDK app (`lib/core-stack.ts`, `lib/spike-stack.ts`)
- `services/`: Lambda handlers
- `web/`: Next.js app (G2 UI, cookie BFF under app/bff)
- `scripts/`: Floci, deploy, grant, spike and smoke tools
- `docs/learn/`: one doc per step + the Floci compatibility report
