# chat-lite: rules for code in this repo

## Code
- Write the least code that does the job well. Remove dead code, unused exports, speculative options and needless indirection.
- Prefer plain, readable code over clever code. A new reader should follow any file without context from elsewhere.
- Follow the language's and framework's best practices (TypeScript strict, React and Next.js conventions, CDK L2 constructs).
- Comments only where the code can't say it: explain *why* (a constraint, a trade-off, a non-obvious AWS behaviour) in full sentences. Never narrate *what* the next line does, and never reference build process or notes ("step 3", "see the plan", "like the other project", ticket or task numbers).
- Names say what things are. Small focused files; one responsibility each.

## Architecture and infrastructure
- Use standard, well-known patterns that are worth learning and explaining in an interview (single-table DynamoDB, BFF with httpOnly cookies, JWT authorizer, conditional writes, resumable SSE, durable execution, and so on). Name resources and constructs after what they are.
- Serverless only: no VPC, NAT or RDS.

## Process
- Tests first (TDD). The full suite stays green.
- After each step's code is written: a cleanup pass against these rules, then the final review. The pass starts with the tools (`npm run check`: knip for unused files, exports and dependencies, then `tsc --noEmit` in every workspace), then a fresh reviewer reads the whole diff plus older code it touches.
- Secrets never enter git: `.env*` and `infra/cdk.context.json` are ignored; scan staged diffs before every commit.
