# Runbook: chat-lite on real AWS

This is how chat-lite goes live at `https://chat.amanarya.com`, in Sydney (`ap-southeast-2`), as the stack `cl-aws-core`. It uses the same account as instagram-lite but its own stack, and it never touches instagram-lite's resources. Aman runs every step by hand; nothing in the repo calls AWS on its own.

Every numbered step ends with:
- **Check:** a command and the output that means it worked;
- **Stop if:** what to do when it didn't. Usually nothing has changed yet, and the right move is to ask for a fix rather than patch things in the console.

## Conventions
- **Shell:** PowerShell, from the repo root. `cdk` commands run in `infra\` (each block says so).
- **`cdk` reads the profile from the environment:** run `$env:AWS_PROFILE = 'ig'` once per shell before any `cdk` command. CDK can't resolve an `aws login` session through `--profile` and stops with "Unable to resolve AWS account".
- **Every `aws` command** carries `--profile ig --region ap-southeast-2`. The only exception is ACM, with `--region us-east-1`, because CloudFront reads certificates only from there.
- **Build the web app before every `cdk synth`, `diff`, `deploy` and `destroy`:** `npm -w web run build:open-next`. The stack ships whatever is in `web\.open-next`, and a synth without it fails with `Build the web app first`.
- **Values never written down here:** the account ID, the alert address, the certificate ARN and every key. The runbook says where each one lives. Two helpers read them when you need them:
  ```powershell
  $account = aws sts get-caller-identity --query Account --output text --profile ig --region ap-southeast-2
  $out = (Get-Content infra\cdk.out\outputs-aws.json -Raw | ConvertFrom-Json).'cl-aws-core'   # after the first deploy
  ```
- **Never:**
  - pass a key on a command line (shell history keeps it);
  - print a secret's value;
  - pass `--require-approval never`;
  - edit or delete this stack's resources in the console, except where a step says to.

## Decisions for Aman
Make these before step 2. Each line gives the recommendation first.
- **Certificate: a single-name certificate for `chat.amanarya.com` (recommended),** or a `*.amanarya.com` wildcard. The single name is the smallest grant and matches what instagram-lite did. A wildcard would also cover future subdomains, and if one already exists in us-east-1 you can reuse it. Only the ARN in `infra\cdk.context.json` changes either way.
- **Load test on AWS: skip it (recommended).** The aws stage always runs real models, so a load test spends real money. It would also hit the throttles (step 10) and, on a new account, the Lambda concurrency quota. The Floci load test already covers the engine.

## 1. Before you start
1. You're on master, and `npm test` and `npm run check` are green. `git status` is clean.
2. Clear the emulator endpoint and log in:
   ```powershell
   Remove-Item Env:AWS_ENDPOINT_URL -ErrorAction SilentlyContinue
   aws login --profile ig --region ap-southeast-2
   ```
3. Check the Lambda concurrency quota. New accounts can sit at 10, and 10 is soon used up: every open run stream holds one Lambda for as long as someone watches it, and every agent run and page render holds another.
   ```powershell
   aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 --query Quota.Value --profile ig --region ap-southeast-2
   aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions --profile ig --region ap-southeast-2
   ```
   If it says 10, request the usual default now, because approval can take days. It doesn't block steps 2–9, which you can do alone, but it does block step 11.
   ```powershell
   aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 1000 --profile ig --region ap-southeast-2
   aws service-quotas list-requested-service-quota-change-history --service-code lambda --query "RequestedQuotas[].[QuotaCode,DesiredValue,Status]" --output text --profile ig --region ap-southeast-2
   ```
4. Cap what the Anthropic key can spend. In the Claude Console (`console.anthropic.com`), set a spend limit of $10 a month (Settings → Limits, or the limits of the workspace the key belongs to). It is the outer guard: a room's own cap only counts what chat-lite meters, and the Console stops the key whatever happens in the app.
5. Make sure no log group from an earlier attempt is in the way. The stack creates `/aws/lambda/<function>` and `/aws/apigateway/cl-aws-api` itself, so a deploy fails if any of them already exists. CDK's own helper Lambdas (the asset copy and the bucket auto-delete) are named after the stack, `cl-aws-core` plus a generated suffix, and Lambda makes their groups itself. Those never collide, so the first command leaves them out:
   ```powershell
   aws logs describe-log-groups --log-group-name-prefix /aws/lambda/cl-aws- --query "logGroups[?!starts_with(logGroupName, '/aws/lambda/cl-aws-core')].logGroupName" --profile ig --region ap-southeast-2
   aws logs describe-log-groups --log-group-name-prefix /aws/apigateway/cl-aws- --query "logGroups[].logGroupName" --profile ig --region ap-southeast-2
   ```

**Check:**
- `aws sts get-caller-identity --query Account --output text --profile ig --region ap-southeast-2` prints the account instagram-lite deploys to;
- the Console's limits page shows the $10 monthly limit;
- `aws cloudformation describe-stacks --stack-name CDKToolkit --query "Stacks[0].StackStatus" --output text --profile ig --region ap-southeast-2` prints `CREATE_COMPLETE` or `UPDATE_COMPLETE`;
- both log-group lists are `[]`. Leftovers from the step-1 spike stack, since removed (names with `spike` in them) don't collide, but you can delete them with `aws logs delete-log-group --log-group-name <name> --profile ig --region ap-southeast-2`.

**Stop if:**
- the login opens the wrong account or project: log in again and pick the right one;
- `CDKToolkit` is missing: carry on, and bootstrap in step 4;
- a log group named after one of this stack's functions exists and you don't know why: ask before deleting it.

## 2. Certificate (us-east-1)
The certificate is requested with the CLI, not CloudFormation, because the account's policy blocks CloudFormation outside Sydney (the same as for instagram-lite).
```powershell
$cert = aws acm request-certificate --domain-name chat.amanarya.com --validation-method DNS --query CertificateArn --output text --profile ig --region us-east-1
aws acm describe-certificate --certificate-arn $cert --query "Certificate.DomainValidationOptions[0].ResourceRecord" --profile ig --region us-east-1
```
The second command can come back empty for a few seconds; run it again until it shows `Name` and `Value`. Then add the validation record at Spaceship (DNS for amanarya.com):
- type `CNAME`;
- host: the `Name` without the trailing `.amanarya.com.` (for example `_abc123.chat`);
- value: the `Value` (`_….acm-validations.aws.`).

Wait for validation:
```powershell
aws acm wait certificate-validated --certificate-arn $cert --profile ig --region us-east-1
```
In a new shell, find `$cert` again with:
```powershell
$cert = aws acm list-certificates --query "CertificateSummaryList[?DomainName=='chat.amanarya.com'].CertificateArn" --output text --profile ig --region us-east-1
```

**Check:** `aws acm describe-certificate --certificate-arn $cert --query Certificate.Status --output text --profile ig --region us-east-1` prints `ISSUED`.

**Stop if:** the wait times out. Check the Spaceship record against `describe-certificate` (the host is usually the problem: Spaceship appends the domain itself). Nothing in the stack exists yet.

## 3. Context file
`infra\cdk.context.json` holds the two account-specific values. It is gitignored and is the only place they live in this repo. The alert address is the same one instagram-lite mails, so copy it across from that repo's file rather than typing it:
```powershell
$env:CERT_ARN = $cert
node -e "const fs = require('fs'); const ig = JSON.parse(fs.readFileSync('../instagram-lite/infra/cdk.context.json', 'utf8')); fs.writeFileSync('infra/cdk.context.json', JSON.stringify({ alertEmail: ig.alertEmail, certificateArn: process.env.CERT_ARN }, null, 2) + '\n')"
Remove-Item Env:CERT_ARN
```
It has the same two keys as `infra\cdk.context.example.json`. Then build and synth:
```powershell
npm -w web run build:open-next
cd infra
npx cdk synth cl-aws-core -c stage=aws --strict -q
cd ..
```

**Check:**
- `git check-ignore infra/cdk.context.json` prints the path, so git ignores it, and `git status` doesn't list it;
- the synth prints nothing and exits 0. `--strict` turns any warning into an error, and the AwsSolutions checks run on every aws synth, so a clean synth means they pass.

**Stop if:**
- the synth names `infra/cdk.context.json`: a value is missing or malformed (an alert address that isn't one, or a certificate outside us-east-1). Fix the file;
- it reports an AwsSolutions finding: ask for a fix. Nothing has been deployed.

## 4. Bootstrap, diff and deploy
```powershell
npm -w web run build:open-next
cd infra
# Only if step 1 found no CDKToolkit:
$account = aws sts get-caller-identity --query Account --output text --profile ig --region ap-southeast-2
npx cdk bootstrap aws://$account/ap-southeast-2 -c stage=aws
npx cdk diff cl-aws-core -c stage=aws
npx cdk deploy cl-aws-core -c stage=aws --outputs-file cdk.out/outputs-aws.json
cd ..
```
- **Read the diff.** Only `cl-aws-core` appears, and on the first deploy every resource is new (`[+]`). On a later deploy, stop if it would replace or delete the table, the user pool, the files bucket or a secret.
- **Deploy.** It lists the IAM changes and asks you to approve them; read them, then answer `y`. The CloudFront distribution takes several minutes.

**Check:**
- `aws cloudformation describe-stacks --stack-name cl-aws-core --query "Stacks[0].StackStatus" --output text --profile ig --region ap-southeast-2` prints `CREATE_COMPLETE` (later deploys print `UPDATE_COMPLETE`);
- `$out = (Get-Content infra\cdk.out\outputs-aws.json -Raw | ConvertFrom-Json).'cl-aws-core'; $out | Format-List` lists `SiteUrl`, `DistributionDomain`, `WebFunctionUrl`, `ApiUrl`, `WsUrl`, `StreamUrl`, `UserPoolId`, `UserPoolClientId`, `TableName`, `McpBaseUrl`, `OpsTopicArn` and `OpsDashboardUrl`.

**Stop if:**
- **the deploy fails.** On AWS a failed deploy rolls back by itself, which Floci can't do. Suspect these first:
  - the AgentCore interpreters (`cl_aws_sandbox_offline`, `cl_aws_sandbox_online`) in Sydney;
  - the run function's durable config;
  - a log group that already exists (step 1).

  Copy the first `CREATE_FAILED` reason from the output and ask for a fix. A failed first create still keeps the retained resources (the table, the user pool, the files bucket and the secrets), so before the next attempt delete them with step 12's second list, and delete the rolled-back stack with `npx cdk destroy`.
- **CDK asks for a newer bootstrap version:** run the bootstrap line, which upgrades `CDKToolkit` in place, then deploy again.

## 5. Keys
CloudFormation creates each secret with a random placeholder, so the app's keys must go in before anyone uses the site. Each Lambda reads a secret once per container and keeps it. The JSON is built by the same helpers `deploy:local` uses (`scripts/src/keys-secrets.ts`), from the repo's `.env`, into a temporary file that is deleted straight after. The value never reaches the command line or the screen.

First, in the GitHub App's settings (`aws-chat-lite-aman`):
- under **Callback URL**, list both `https://chat.amanarya.com/bff/github/callback` and `http://localhost:3000/bff/github/callback`. GitHub refuses any other return address for the admins' sign-in;
- leave **Request user authorization (OAuth) during installation** off;
- under **Client secrets**, generate a client secret, and put it and the Client ID into `.env` as `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`, if they aren't there from local testing.

Define this once per shell:
```powershell
function Set-ChatSecret([string]$SecretId, [string]$Build) {
  $tmp = New-TemporaryFile
  try {
    $env:SECRET_FILE = $tmp.FullName
    npx tsx -e "import('node:fs').then(async (fs) => { const k = await import('./scripts/src/keys-secrets.ts'); const env = fs.readFileSync('.env', 'utf8'); fs.writeFileSync(process.env.SECRET_FILE, $Build); })"
    if ($LASTEXITCODE -ne 0) { throw "Couldn't build $SecretId; nothing was sent." }
    aws secretsmanager put-secret-value --secret-id $SecretId --secret-string "file://$($tmp.FullName)" --query VersionStages --output text --profile ig --region ap-southeast-2
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Remove-Item Env:SECRET_FILE -ErrorAction SilentlyContinue
  }
}
```

| Secret | What it holds | How to fill it |
|---|---|---|
| `cl-aws-model-keys` | `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `GEMINI_API_KEY` (the image tool) | `Set-ChatSecret cl-aws-model-keys 'k.modelKeysSecret(env)'` |
| `cl-aws-tool-keys` | `TAVILY_API_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (read from the `.pem` file that `GITHUB_APP_PRIVATE_KEY_PATH` names in `.env`), `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | `Set-ChatSecret cl-aws-tool-keys "k.toolKeysSecret(env, (path) => fs.readFileSync(path, 'utf8'))"` |
| `cl-aws-token-key` | The key that seals rooms' MCP sign-ins. CloudFormation generated it and nobody ever sees it | **Don't touch it.** A new value makes every stored MCP sign-in unopenable |
| `cl-aws-push-keys` | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, read only by the push worker. The pair in `.env` (made with `npx web-push generate-vapid-keys`), or one made for AWS; a new pair later orphans every subscribed device | `Set-ChatSecret cl-aws-push-keys 'k.pushKeysSecret(env)'` |
| `cl-aws-push-public-key` | `VAPID_PUBLIC_KEY` alone, from the same `.env` as `cl-aws-push-keys`: the push routes hand it to browsers and never see the private key | `Set-ChatSecret cl-aws-push-public-key 'k.pushPublicKeySecret(env)'` |

Nothing else needs filling:
- **No sandbox token on AWS:** that token only guards the local Docker sandbox server, and AWS uses AgentCore.
- **The origin secret** (the `x-origin-verify` header between CloudFront and its origins) is derived from the stack's own ID and isn't in Secrets Manager. Anyone who can read the account can see it, and it can't be rotated short of recreating the stack. If it leaks, ask for a fix.

**Check**, for each secret you filled:
- `aws secretsmanager describe-secret --secret-id cl-aws-model-keys --query VersionIdsToStages --profile ig --region ap-southeast-2` shows two versions, one `AWSCURRENT` and one `AWSPREVIOUS` (the placeholder);
- this prints the key names and nothing else:
  ```powershell
  aws secretsmanager get-secret-value --secret-id cl-aws-model-keys --query SecretString --output text --profile ig --region ap-southeast-2 | node -e "let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => { try { console.log(Object.keys(JSON.parse(s)).join(', ')) } catch { console.log('not JSON') } })"
  ```

**Stop if:** the helper says `.env is missing …`. Add the named key to `.env` and run the line again; nothing was sent.

## 6. Alarm email
After the first deploy, AWS mails a confirmation link to the alert address. Click it. Nothing arrives until you do.

Each alarm mails on its way into `ALARM` and again back to `OK`. A new alarm also mails `OK` once, a few minutes after the deploy that creates it, as it leaves its starting state. So after a deploy that adds functions, expect one `OK` mail per new alarm (up to all 23 if you confirm within minutes of the first deploy). They need nothing.

**Check:**
- `aws sns list-subscriptions-by-topic --topic-arn $out.OpsTopicArn --query "Subscriptions[].SubscriptionArn" --output text --profile ig --region ap-southeast-2` prints an ARN, not `PendingConfirmation`;
- a test alarm, `aws cloudwatch set-alarm-state --alarm-name cl-aws-health-errors --state-value ALARM --state-reason "runbook test" --profile ig --region ap-southeast-2`, sends an `ALARM: "cl-aws-health-errors"` mail within a minute, and an `OK` mail when the alarm next evaluates, within about 5 minutes.

**Stop if:**
- no confirmation mail came. Check spam, then resend it from the console (SNS → Topics → `cl-aws-ops` → Subscriptions → Request confirmation);
- the subscription is confirmed but no `ALARM` mail came within about 5 minutes of `set-alarm-state`. Read what the alarm did:
  ```powershell
  aws cloudwatch describe-alarm-history --alarm-name cl-aws-health-errors --history-item-type Action --query "AlarmHistoryItems[].HistorySummary" --profile ig --region ap-southeast-2
  ```
  A `Failed to execute action` line that names `SNS:Publish` means the topic's policy refuses CloudWatch, so no alarm can mail. Ask for a fix; don't edit the topic policy in the console. Set the test alarm back first (its row in "When an alarm fires").

## 7. DNS and the site
At Spaceship, add a record:
- type `CNAME`;
- host `chat`;
- value: the `DistributionDomain` output (`$out.DistributionDomain`, a `….cloudfront.net` name).

**Check:**
- `(Resolve-DnsName chat.amanarya.com -Type CNAME).NameHost` equals `$out.DistributionDomain`;
- `curl.exe -sI https://chat.amanarya.com/login` shows status 200 and a `strict-transport-security` header;
- `curl.exe -s -o NUL -w "%{http_code}" "$($out.WebFunctionUrl)login"` prints `403`. The web Lambda refuses anything that didn't come through CloudFront;
- `curl.exe -s "$($out.ApiUrl)/health"` prints `{"ok":true,"stage":"aws",…}`;
- `curl.exe -s https://chat.amanarya.com/.well-known/oauth-authorization-server` prints JSON with `"issuer":"https://chat.amanarya.com"`, which shows the OAuth paths reach the API through CloudFront;
- `curl.exe -s -o NUL -w "%{http_code}" -X POST https://chat.amanarya.com/mcp` prints `401` (MCP without a token);
- `curl.exe -si "https://chat.amanarya.com/runs/nope/stream?ticket=nope"` shows status 401 and `{"error":"This stream link has expired or was already used."}`. A streamed status prelude passes through CloudFront, which Floci couldn't show.

**Stop if:**
- DNS doesn't resolve after about 15 minutes: check the record at Spaceship;
- the Function URL answers 200: the origin check is off. Don't invite anyone; ask for a fix;
- the site gives a CloudFront error: send the status code and the `x-cache` header.

## 8. First user and a walk-through with real models
1. Sign up at `https://chat.amanarya.com` with your username and email. The code arrives from Cognito's default sender, which allows about 50 mails a day.
2. Let yourself create rooms, then sign out and in again:
   ```powershell
   npm run grant -- <username> creators --stage=aws
   ```
3. Walk the main path once, with a second account in a private window (another address of yours):
   1. Create a room and copy its invite link.
   2. The second account opens the link and joins.
   3. Chat both ways: typing shows, and messages arrive live.
   4. Attach an image; it previews for both accounts.
   5. Start a thread with `@agent` on **Haiku** (cents). Its answer streams in; steer it once, then stop it.
   6. The room's spend shows a few cents.

**Check:** creating the room works, and every step of the walk does what it says.

**Stop if:**
- `grant` says `No UserPoolId`: the outputs file is missing; run step 4's deploy again with `--outputs-file`;
- a step fails: note the time and run the Logs Insights query in step 9 (the reserved words row).

## 9. What only AWS proves
Floci passed all of these locally or couldn't run them at all. Check each row once on AWS. Keep the walk within the spec's real-key cap: **$3 in all**, Haiku unless a row says otherwise.

| What | How to check on AWS | Passing looks like |
|---|---|---|
| SSE through CloudFront | In DevTools → Network, open a running thread's `/runs/<id>/stream` request and its EventStream tab | Events arrive one by one, not all at the end |
| Resume with `Last-Event-ID` | Reload the page mid-run | The stream carries on from where it was, with no repeated or missing steps |
| A hang-up ends the stream Lambda | Close the tab mid-run, then `aws logs tail /aws/lambda/cl-aws-stream --since 10m --profile ig --region ap-southeast-2` | The invocation's `REPORT` line appears within seconds of closing, not 15 minutes later |
| WebSocket fan-out | Two browsers in one chat | Each sees the other's messages and typing live |
| Offline presence | Close one browser's tab | The other shows it offline within seconds (on Floci this took up to 20 s) |
| GSI lag | Accept an invite with the second account | The room appears in its sidebar without a reload |
| Transaction conflicts | Both accounts click Approve on the same GitHub write at the same moment | One wins, the other sees `Already approved by <u>.`, and GitHub shows one write |
| IAM on every route (Floci enforces none) and real DynamoDB validation (reserved words) | After walking every feature once, open CloudWatch Logs Insights, select every `/aws/lambda/cl-aws-*` group and run the query below | Zero rows |
| Attachments on the real origin | Upload a 9 MB file, then an 11 MB one | The 9 MB file uploads and downloads, the 11 MB one is refused, and images preview |
| Room files expire from staging | A day after uploading room files, with `$account` set as in Conventions: `aws s3 ls "s3://cl-aws-files-$account/staging/" --recursive --profile ig --region ap-southeast-2` | Nothing older than about a day |
| Agent runs with a real model | A Haiku thread: stream, steer, stop | All three work, and the cost shows |
| GitHub sign-in on the real GitHub (no automated test reaches it) | In a room you own: **Connections → Connect GitHub**. The first time, GitHub asks you to authorize the App. Then revoke the App under your GitHub **Settings → Applications → Authorized GitHub Apps**, click **Change repos** and press **Cancel** | You land back in the room with the picker open, listing only `Am4nn` and `Am4nn/chat-lite-playground`; saving shows the chip and an Activity line. The cancel gives the toast `GitHub didn't allow access (access_denied).` (the full check is "Checking the GitHub sign-in by hand" in `docs/learn/07-tools-approvals.md`) |
| Durable callback on approval | With the playground connected (the row above), ask for a comment on the playground repo (`Am4nn/chat-lite-playground`), then Approve | The run resumes at once and the comment appears; delete it afterwards |
| Sandbox offline (AgentCore) | With the room's internet off, ask the agent to run `print(6*7)` | `42`, shown as the step's output |
| Sandbox online | Turn the room's internet on and ask it to fetch `https://example.com` with Python | The page's HTML comes back; with the internet off, the same request fails |
| No AWS credentials in the sandbox | Ask it to run `import os; print([k for k in os.environ if k.startswith("AWS")])` | `[]` |
| Sandbox files round-trip | Ask it to write `out.txt`, then open the Files panel | `out.txt` is there with the right content |
| chat-lite as an MCP server | `claude mcp add --transport http chat-lite-aws https://chat.amanarya.com/mcp`, sign in on `/consent`, then ask Claude Code to `list_rooms` | Your room is listed; `/apps` shows the client, and Remove ends its access |
| Budget stop | Lower the test room's cap below what it has spent, then start a run | The run stops with the cap message before calling the model |
| Schedules in a time zone | Set the room's zone to `Australia/Sydney` (it observes daylight saving) and add a schedule a few minutes ahead in local time | It fires at that local time, not an hour off. The next DST change in Sydney is in April 2027; check that a daily schedule still fires at the same local hour the day after |
| Voice in and out (Floci fakes both) | Dictate a message in Chrome and use read-aloud on an answer. The aws stage dictates in the browser (`dictation: "browser"` in `infra/lib/config.ts`), because the free plan's service control policy denies Amazon Transcribe; the voice Lambda and its routes still deploy and serve read-aloud. The live suite, `$env:AWS_PROFILE='ig'; $env:AWS_REGION='ap-southeast-2'; $env:REAL_AWS='1'; npm -w services run test:live -- voice` then `Remove-Item Env:REAL_AWS, Env:AWS_PROFILE, Env:AWS_REGION`, passes only on a paid plan: its Transcribe case fails with that explicit deny until then. After an upgrade, set the aws stage's `dictation` to `"transcribe"`, deploy, and run the suite | Words appear while you speak, with a `?` beside the mic saying the browser recognises them; in Firefox there is no mic. The answer plays in the Matthew voice (Polly). On a paid plan with `"transcribe"`, the suite passes for well under a cent, and the budget moves by about 167 µ$ a second |
| Gemini images | Ask the agent for an image | It appears under the answer and in the room's files, and the cost shows |
| Web push | Turn notifications on for each device (Android Chrome, desktop, iPhone from the home screen), then get mentioned from the other account | Each device shows the notification |
| The certificate | `curl.exe -sS -o NUL -w "%{http_code}" https://chat.amanarya.com/login` | `200` and no certificate error: curl checks that the certificate matches the name. The TLS 1.2 minimum is pinned by the infra tests |

The query for the IAM and DynamoDB row:
```
fields @timestamp, @log, @message
| filter @message like /ValidationException|reserved keyword|TransactionCanceled|AccessDenied|not authorized/
| sort @timestamp desc
```

**Check:** every row passes, and Billing shows the walk within $3.

**Stop if:** a row fails. Note the time and the row, copy the matching log lines, and ask for a fix. Don't invite anyone until every row passes.

## 10. Ops and cost
Open `$out.OpsDashboardUrl`.

**Check:**
- every alarm is OK (23 of them: one errors alarm for each of the 20 functions, `cl-aws-api-5xx`, `cl-aws-ws-execution-errors` and `cl-aws-lambda-throttles`);
- every function has a line on the "Lambda errors" graph. Per function the dashboard shows only errors, so it stays free; a function's duration and throttles are on its own Monitor tab in the Lambda console.

**The expected idle floor per month,** with nobody using the site:
- Secrets Manager: $0.40 per secret, 5 of them ($2);
- CloudWatch alarms: $0.10 per alarm, 23 of them, less the account's free 10, which instagram-lite's alarms share ($1.30 to $2.30);
- the `cl-aws-ops` dashboard: it charts 37 metrics, under the 50 a free dashboard allows, so it is free while the account has no more than 3 dashboards; a fourth costs $3;
- logs, the table and its point-in-time recovery, CloudFront and S3: cents.

So expect about $3.30 to $4.30 a month before anyone signs in ($6.30 to $7.30 if the dashboard isn't one of the free three). Lambda, API Gateway, DynamoDB requests and the models cost only when used.

The next day, check Billing.

**Throttles:** every route of the HTTP API and of the socket's `live` stage allows 50 requests a second, with bursts of 100. On the socket stage that also limits new connections. That's far above what a few friends send. Raise it (`EDGE_THROTTLE` in `infra/lib/config.ts`, then deploy) before any load test.

**Stop if:** an alarm isn't OK, or a function has no lines after the walk. Ask why before inviting anyone.

## 11. Invite friends
> **First:** the GitHub sign-in row of step 9 passes on AWS. It is what keeps a friend who admins a room to the installations their own GitHub account reaches, and to the repos it can push to, so nobody can connect your repos.

1. Confirm the Lambda concurrency increase from step 1 was approved:
   ```powershell
   aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions --profile ig --region ap-southeast-2
   ```
   It should show more than 10. If AWS refused it on the Free plan, keep to a handful of friends and few runs at once.
2. Create one room and share its invite link. Keep the cap at the default $3.
3. Watch the dashboard for a day.

**Check:** the friends sign up (at most about 50 sign-up mails a day), join the room, and every alarm stays OK.

**Stop if:** any alarm fires. Follow the next section.

## When an alarm fires
Each alarm mail says what users feel and links here. When it clears, the `OK` mail follows.

**First:**
1. Open `$out.OpsDashboardUrl` and note which alarm fired and when.
2. Read the logs around that time:
   ```powershell
   aws logs tail /aws/lambda/<function> --since 30m --format short --filter-pattern "?ERROR ?timed" --profile ig --region ap-southeast-2
   ```
   Or open Logs Insights on that function's group:
   ```
   fields @timestamp, @requestId, @message
   | filter @message like /ERROR|Task timed out/
   | sort @timestamp desc
   | limit 50
   ```

**Then by alarm:**

| Alarm | What users feel | What to do |
|---|---|---|
| `cl-aws-web-errors` | Pages or actions fail: the site is down for them | Check the logs. A deploy just before? Redeploy the last good commit |
| `cl-aws-live-errors` or `cl-aws-ws-execution-errors` | Messages don't send; typing, presence and live updates stop | Check `cl-aws-live`'s logs; a timeout means a route took more than 29 s. The dashboard's "Socket errors" graph also counts refused connects (a stale or forged ticket) as 4xx/5xx from the Lambda; those are normal and alarm nothing |
| `cl-aws-chat-errors` | History, search or file links fail | Check the logs |
| `cl-aws-rooms-errors` | Rooms, invites or members fail | Check the logs |
| `cl-aws-threads-errors` | New threads don't start | Check the logs |
| `cl-aws-run-errors` | Agent runs end with "The agent hit an error" | Check the logs. A provider error (status 5xx or `overloaded`) clears on its own. A key error means checking the model keys' names (step 5's check) |
| `cl-aws-stream-errors` | Live run output stops streaming; a reload still shows the run | Check the logs |
| `cl-aws-files-errors` | The Files panel fails | Check the logs |
| `cl-aws-connections-errors` or `cl-aws-mcp-connections-errors` | GitHub sign-in, GitHub or remote MCP connections fail in the Connections tab | Check the logs; then GitHub's status, or the remote server |
| `cl-aws-oauth-errors` or `cl-aws-mcp-errors` | Claude Code or Desktop can't sign in to chat-lite, or its tools fail | Check the logs |
| `cl-aws-presignup-errors` | Sign-ups are refused | Check the logs |
| `cl-aws-health-errors` | Nothing (it's the runbook's test alarm) | Set it back: `aws cloudwatch set-alarm-state --alarm-name cl-aws-health-errors --state-value OK --state-reason "runbook test" --profile ig --region ap-southeast-2` |
| `cl-aws-api-5xx` | Pages and actions fail across the app | Run the query below on the `/aws/apigateway/cl-aws-api` access logs: the route names the function, so read that function's logs next |
| `cl-aws-lambda-throttles` | Errors everywhere: the account ran out of concurrency | The dashboard's account-wide concurrency graph shows when; to see who, open CloudWatch → Metrics → Lambda → By Function Name and graph `ConcurrentExecutions`. instagram-lite shares the same quota. Request the increase (step 1), and stop runs until it lands. `WebFunctionUrl` and the stream's Function URL are public with nothing throttling them, so a flood of direct calls shows as a spike on `cl-aws-web` or `cl-aws-stream` alone. Once the quota is raised, cap that function at once with `aws lambda put-function-concurrency --function-name cl-aws-web --reserved-concurrent-executions 20 --profile ig --region ap-southeast-2` (the stack doesn't set it, so a deploy keeps it; `delete-function-concurrency` lifts it), then ask for a fix |

The access log query for `cl-aws-api-5xx`:
```
fields @timestamp, routeKey, status, integrationError
| filter status >= 500
| stats count(*) by routeKey, integrationError
```

**Two ways out:**
- **To stop spend at once,** lower the room's cap below what it has spent (runs stop at their next model call), and stop the running threads.
- **To roll back a bad deploy,** check out the last good commit and repeat step 4's build and deploy.

Don't patch resources in the console: the next deploy would undo or trip over it. Ask for a fix.

## 12. Tear down
```powershell
npm -w web run build:open-next
cd infra
npx cdk destroy cl-aws-core -c stage=aws
cd ..
$account = aws sts get-caller-identity --query Account --output text --profile ig --region ap-southeast-2
```
The destroy takes everything except users' data and the keys. CloudFront takes several minutes to disable and delete.

**These stay, on purpose:**

| Kept | Delete it with |
|---|---|
| table `cl-aws-main` (with point-in-time recovery) | `aws dynamodb delete-table --table-name cl-aws-main --profile ig --region ap-southeast-2` |
| user pool `cl-aws-users` | `$pool = aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='cl-aws-users'].Id" --output text --profile ig --region ap-southeast-2`, then `aws cognito-idp delete-user-pool --user-pool-id $pool --profile ig --region ap-southeast-2` |
| files bucket `cl-aws-files-<account>` | `aws s3 rb "s3://cl-aws-files-$account" --force --profile ig --region ap-southeast-2` (empties it first) |
| secrets `cl-aws-model-keys`, `cl-aws-tool-keys`, `cl-aws-token-key`, `cl-aws-push-keys` and `cl-aws-push-public-key` | `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery --profile ig --region ap-southeast-2`. Without the flag, the name stays taken for 7 to 30 days |

Delete them only when you really want friends' data, accounts and keys gone. A fresh deploy fails while the table, the bucket or a secret exists, because their names are taken. There's no deploy that adopts the old ones, so to keep the data, update the stack in place rather than destroying it.

Then:
- remove the `chat` CNAME at Spaceship;
- keep the certificate (it's free). If you delete it (`aws acm delete-certificate --certificate-arn $cert --profile ig --region us-east-1`, once the distribution is gone), remove its validation CNAME too.

**Check:**
- `aws cloudformation describe-stacks --stack-name cl-aws-core --profile ig --region ap-southeast-2` says the stack does not exist;
- `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/cl-aws- --query "logGroups[?!starts_with(logGroupName, '/aws/lambda/cl-aws-core')].logGroupName" --profile ig --region ap-southeast-2` prints `[]`. A Lambda that ran during the destroy can leave its group behind, and the next deploy would trip over it. Delete any leftovers.

CDK's helper Lambdas leave `/aws/lambda/cl-aws-core*` groups that the stack doesn't own, so they survive the destroy and never expire. They're harmless and never block a deploy. To delete them too:
```powershell
(aws logs describe-log-groups --log-group-name-prefix /aws/lambda/cl-aws-core --query "logGroups[].logGroupName" --output text --profile ig --region ap-southeast-2) -split '\s+' | Where-Object { $_ } | ForEach-Object { aws logs delete-log-group --log-group-name $_ --profile ig --region ap-southeast-2 }
```

**Stop if:** the destroy fails (`DELETE_FAILED`). Send the resource and reason, and ask for a fix rather than deleting resources by hand.
