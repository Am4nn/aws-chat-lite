# chat-lite

Team rooms where people and their own shared AI agents work side by side, built the way AI chat
platforms are built (WebSockets, resumable SSE, agent loop, MCP, sandboxes, budgets) on serverless AWS.
A learning project, sibling of [aws-instagram-lite](https://github.com/Am4nn/aws-instagram-lite).

**Status:** step 11, ready for real AWS (CloudFront site, alarms, hardening, cdk-nag gate and the runbook); not deployed yet. Design: [docs/superpowers/specs/2026-11-10-chat-lite-design.md](docs/superpowers/specs/2026-11-10-chat-lite-design.md).
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
```

## Deploy to real AWS
Follow [docs/runbook-aws.md](docs/runbook-aws.md) step by step: certificate, context file, deploy, keys, alarm email, DNS and the checks that only real AWS can pass. Nothing in the repo calls AWS by itself.

## Layout
- `infra/`: CDK app (`lib/core-stack.ts`; on AWS only `lib/web.ts` for the CloudFront site, `lib/ops.ts` for alarms and the dashboard, `lib/compliance.ts` for the AwsSolutions checks)
- `services/`: Lambda handlers
- `web/`: Next.js app (G2 UI, cookie BFF under app/bff)
- `scripts/`: Floci, deploy, grant and smoke tools
- `docs/learn/`: one doc per step + the Floci compatibility report
- `docs/runbook-aws.md`: the real-AWS deploy, by hand
