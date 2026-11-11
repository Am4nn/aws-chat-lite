# Step 6: Sandbox and room files

## What we built
- **Agents run code.** A model can call one more tool, `sandbox_run {language, code, timeoutSec}`, with shell, Python or JavaScript. The code runs in an isolated sandbox with no AWS credentials, no secrets in its environment and, by default, no internet. (On AWS the offline interpreter's `SANDBOX` network mode still reaches S3, so code could upload to a presigned URL it was handed; that is checked on the first AWS deploy.) On AWS that's an AgentCore Code Interpreter; locally it's a Docker container.
- **Each room has shared files.** Up to 100 MB, 1,000 files and 25 MB per file. Members upload, download, replace and delete them in the panel's **Files** tab, and every agent's sandbox sees them in its working directory. What the code writes or deletes there is saved back to the room after each step.
- **Changes are live.** A file another member or an agent saves slides into everyone's list, with who changed it (`@name` or `#12 thread-name`) and when.
- **Two writers, one file: the last write wins, out loud.** When a thread overwrites a version it never saw, its step says so ("data.csv was changed by @aman after this run loaded it; this run's version replaced it."). A delete never removes a newer version someone else wrote.
- **An internet switch per room.** Off by default. Owners and admins turn it on (then `pip install` and `git clone` work); members see the setting. It applies to the next session. Locally, sessions go online only when the sandbox server was started with `SANDBOX_LOCAL_INTERNET=1`; otherwise they run offline and each step says "Internet is off for sandboxes on this machine, though the room allows it."
- **The sandbox costs money like a model does.** Each sandbox step is billed by wall time at 61 µ$ a second, into the same monthly budget, and a thread that has run code is marked private (`sandbox files`), so DeepSeek is never offered it.
- **`npm run smoke`** gained 6 room-file checks: an upload and its replacement reaching another member, a file an agent's `sh` step saves, a delete, the internet switch, the Files tab at phone width, and the slide-in under normal and reduced motion.

## How to try it
```powershell
npm run sandbox:build                     # builds the cl-sandbox:1 image (once, ~450 MB)
npm run floci:up; npm run deploy:local    # deploy bakes this checkout's sandbox token into the run Lambda
npm run dev                               # the web app, the run stream on :4600 and the sandbox server on :4700
$env:SANDBOX_LOCAL_INTERNET = "1"; npm run dev   # the same, with internet for rooms that allow it (never with --live-models)
npm -w services run test:int              # includes the Docker and sandbox files
npm run smoke                             # needs npm run dev running
```
`npm run sandbox:local` starts the sandbox server alone. In a room, start a thread with a code span and the fake model runs it as one `sandbox_run` call per span:

| Span | Runs |
|---|---|
| `` sh`echo hi > hi.txt` `` | a shell command |
| `` py`print(6*7)` `` | Python 3.12 |
| `` js`console.log(1+1)` `` | Node 20 |

So `@agent make sh`echo hi > hi.txt`` makes a thread whose one step writes `hi.txt`, and the file appears in the Files tab, credited to the thread. Open the step to see its output, then the "Saved to room files" line.

## How a sandbox step flows
```mermaid
sequenceDiagram
  participant R as run Lambda (durable step)
  participant D as DynamoDB
  participant S as S3 (cl-<stage>-files)
  participant X as Sandbox (AgentCore / Docker via :4700)
  participant B as Browsers (WebSocket)
  R->>D: ADD taint "sandbox" (before any code runs)
  R->>D: get RUN#id / SANDBOX, or start a session + conditional put
  R->>D: query FILE# items (the room's manifest)
  R->>X: exec(removal script): files the room dropped, then emptied folders
  R->>S: GetObject for files whose version changed
  R->>X: writeFiles (pull)
  R->>X: exec(code, timeout)
  R->>D: SANDBOX item: the exec result (a retry of this step reuses it)
  R->>X: exec(LIST_CODE): path, size, sha256 of every file
  R->>D: delete FILE items the code deleted (first, so they free room)
  R->>X: readFiles for new or changed ones
  R->>S: PutObject workspaces/<room>/<uuid> (a new object per version)
  R->>D: commit: FILE item → new object, ADD META totals (one transaction)
  R->>S: DeleteObject of the replaced version
  R->>D: save the session's manifest and the step's result; files.synced event
  R-->>B: files.updated {files, deleted}, or {refetch} past 64 KB
  R->>D: CALL#sandbox-<step>: usage + spend (one transaction)
```
When the run closes (done, stopped, failed or capped), `closeSandbox` stops the session and deletes the `SANDBOX` item, before `run.finished` is written.

## The patterns
**Sandboxed execution without secrets or egress.** The agent's code is untrusted: it was written by a model that read whatever the users and the web pasted into the thread. So the sandbox gets nothing worth stealing. On AWS each interpreter is created **without an execution role**, so there are no AWS credentials inside, and the run Lambda moves every byte in and out through the invoke API: code inside can't reach S3, DynamoDB or another room's files. Locally the container runs with `--network none`, `--cap-drop ALL`, `no-new-privileges`, user 1000, 1 GB of memory, 1 CPU and 256 processes, and no `-e`, `-v` or `--mount`. The image is even rebuilt on `scratch` so it doesn't inherit the Python base image's `GPG_KEY` variable. Internet is a separate, admin-only choice: on AWS it picks a whole second interpreter (`PUBLIC` network mode instead of `SANDBOX`), so a session can't switch itself online.

**One interface with a local substitute.** The run loop only knows `Sandbox`: `start`, `exec`, `writeFiles`, `readFiles`, `stop`, and `SandboxGone` for a session that vanished. Listing and removing files are shell scripts the run sends through `exec` (`sandbox/scripts.ts`), so both adapters run the same code and no path is ever quoted for a shell: the removal script carries its paths as base64. Three adapters sit behind it. `agentcore.ts` calls `StartCodeInterpreterSession` / `InvokeCodeInterpreter` / `StopCodeInterpreterSession`, running all code as a base64 temp file under `timeout` through `executeCommand` (in 64 KB pieces, since Linux refuses a single argument over 128 KB), so no user text is ever quoted for a shell. `docker.ts` drives the Docker CLI. And `remote.ts` is a client for `server.ts`, because Floci's Lambdas run in containers that can't start containers: the local run Lambda calls a small HTTP server on the host (`host.docker.internal:4700`), which calls `docker.ts`. `SANDBOX_KIND=docker|agentcore` picks one. Everything above the interface (sync, billing, notes, taint) is the same code on both, and is tested once.

**A token-protected host server.** That server can start containers and run anything in them, so it's guarded like an admin API even though it's local. It binds `127.0.0.1` only. It accepts only the `Host` headers `127.0.0.1:4700` and `host.docker.internal:4700`, which stops DNS rebinding from a web page. Every call needs `x-sandbox-token`, compared as sha256 digests with `timingSafeEqual`, and `content-type: application/json`, which a cross-site form or `no-cors` fetch can't send. A handle must be a 64-hex container id whose container carries the `cl-sandbox=1` label, so a stolen token still can't `exec` into Floci. The token is a random 32 bytes in the gitignored `.secrets/sandbox-token`, which `deploy:local` bakes into the local run Lambda's environment.

**Write-new, swap-pointer, delete-old.** A room file is a DynamoDB item (`ROOM#<room> / FILE#<path>`) pointing at an S3 object, and every version is a **new** object (`workspaces/<room>/<uuid>`). A write uploads the new object first, then a transaction moves the pointer (conditioned on the version it read), then deletes the old object. A reader therefore always sees a whole old version or a whole new one, never a half-written file, and a failed commit leaves the old version live. Member uploads use a presigned POST into `staging/<room>/<user>/`, then the commit copies it into `workspaces/` server-side, so the browser never gets a URL that writes a live file. The cost is a possible orphan object when a Lambda dies between the commit and the delete; it's invisible and small.

**A quota as a conditional transaction.** The room's `META` keeps `filesBytes` and `filesCount`, changed only with `ADD` in the same transaction as the `FILE` item, and the `ADD` is conditioned on the result staying under 100 MB and 1,000 files. So the totals are always the sum of the files, and two writers can't both squeeze past the cap: of two 6-byte commits racing at 10 bytes under it, exactly one fails (the repo int test races them). An overwrite adds only its size difference.

**Manifest-based two-way sync with visible last-write-wins.** The session remembers a manifest: for each path, the room version and sha256 it holds. Before each exec the run **pulls** only the files whose room version differs; after it, the code lists the working directory (regular files only, symlinks never followed, `.git`, `node_modules`, `.venv` and friends skipped) and the run **pushes** files whose sha256 changed and deletes files that vanished. Pull before and push after every step (rather than once per session) means a member's upload reaches a live session by the next step. The listing is Python run with `-I` (isolated mode), because the working directory and the user's site-packages hold code the agent wrote: a planted `json.py` or `.pth` file would otherwise run in its place. It hashes in 1 MB chunks, doesn't hash a file too big for the room, reports unreadable paths and non-UTF-8 names instead of failing, and stops at 2,000 entries or 512 KB. A push **deletes first** and counts those deletes against the limits first, so `mv a b` in a full room keeps the file; a pull also removes first (and prunes the folders that leaves empty), so a file can take a folder's place. Neither side ever lets a file and a folder share a name: a clash is skipped with a note. Once the code has run, nothing about the files themselves can fail the step: an unreadable file, a listing cut short (no deletes then, since a file past the cut looks deleted), a commit that keeps conflicting or a lost session all become notes, capped at 20 plus "…and N more" (and 50 paths per list) so a step that unpacks thousands of files can't flood the model's context or DynamoDB's 400 KB items. Conflicts are settled by rule, not by locking: a write commits over whatever the room has now, and if that's a version the run never loaded, the step's output names who it overwrote. A delete is conditioned on the version the run loaded, so it can't drop a newer one. Every note shows up in the step's output (so the model reads it too) and in the `files.synced` event.

**A session tied to a durable run.** A run opens one session on its first `sandbox_run` and stops it when the run closes, however it ends. The `RUN#<id> / SANDBOX` item holds the handle, and it's written with `attribute_not_exists`: a retried step that loses the race stops the session it just started and uses the stored one, so a durable retry never opens a second session. A session that died mid-run (a killed container, an expired AgentCore session) raises `SandboxGone`, and the step opens **one** new session, pulls everything and runs the code once more; a second loss ends the step with "The sandbox stopped unexpectedly. Try again." A session lost *after* the code ran isn't rerun: the step reports the code's output and that its file changes are lost. And because durable steps run at least once (a crash, a failed write, the 15-minute Lambda limit cutting a long step), the `SANDBOX` item records the step's exec result the moment the code returns, and its finished result after the push; a retry of that step syncs from the stored result, or returns the finished one, so `echo x >> log` runs once. A Stop asked for while code runs stops the session (the one kill every sandbox offers), so the run ends within seconds rather than after the exec. Sessions also carry their own deadline (AgentCore `sessionTimeoutSeconds`, Docker `sleep`), set to the time until the run is surely over (135 min after it started, less what has passed), so a session whose run vanished or was closed as dead from another function still ends.

**Taint from tool use.** A thread that has run code may have read private room files, so before the first exec the step adds `"sandbox"` to the thread's `taint` set (`ADD`, so it's idempotent). The model picker greys DeepSeek out for a tainted thread, a running DeepSeek turn stops, and DeepSeek is never offered `sandbox_run` in the first place. The run also refuses any tool call it didn't offer, in case a model names one anyway. Taint lands before the code runs, so even a step that crashes halfway leaves the thread marked.

**Metering wall time.** A sandbox step is billed from its wall time (pull + exec + push), rounded up to whole seconds, at 61 µ$/s, as `usage {model: "sandbox", job: "sandbox"}` with zero tokens. It's recorded with the same one-transaction marker as a model call (`CALL#sandbox-<step>`), so a retried step is billed once. Idle time between steps is free here; AgentCore bills active CPU and memory, which this approximates from above.

## Rulings
These were judgement calls during the build. Each line says what we chose and what it costs if the choice turns out wrong.

**Limits and timings**
| Ruling | Cost if wrong |
|---|---|
| 100 MB, 1,000 files and 25 MB per file per room; `SKIPPED_DIRS` never synced | Big datasets and `.git` history stay session-only; each limit is one constant |
| Paths: relative POSIX, ≤ 200 chars, ≤ 8 segments of ≤ 100; no `..`, leading `/`, backslash, `: * ? " < > \|`, control chars, line separators, lone surrogates (non-UTF-8 names) or invisible format chars (`U+202E`, `U+200B`); a file can't share a path with a folder | A name that's legal on Linux but refused gets a "wasn't saved" note; an emoji joined with `U+200D` is refused too |
| No Unicode normalisation of paths: `é` as one code point and as `e` + accent are two files | Two look-alike names can sit side by side; normalising would make a sandbox's own name and its room copy differ and re-save the file every step |
| Exec timeout 60 s by default, 300 s at most; stdout and stderr each keep their last 8,000 characters | A long build needs several steps |
| A session lives until 135 min after its run started (the run's dead-after time) | None: the run ends first |
| A step's exec result is stored on the `SANDBOX` item and reused by a retry of that step | One more write per step; a crash *during* the exec still reruns it, since nothing returned |
| Stop during exec stops the whole session; the step saves nothing | Files the stopped code wrote are lost; the run is ending anyway |
| Listing capped at 2,000 entries or 512 KB; notes at 20 and path lists at 50, then "…and N more"; `files.updated` over 64 KB becomes a refetch | A huge working directory saves no deletes that step; the model sees counts, not every name |
| 100 signed uploads per member per hour | A bulk upload of more waits an hour |
| 61 µ$ per wall second of a sandbox step (2 vCPU + 4 GB at AgentCore's list price, recalled, not read) ⚑ | Off by up to ~2× against AgentCore's real bill; re-checked before the first AWS deploy |

**Design calls**
| Ruling | Cost if wrong |
|---|---|
| A session lives for one run, not for the thread; each run starts from the room files | `pip install`s are redone per run. Per-thread idle sessions would need a sweeper and idle billing |
| Locally a host HTTP server wraps the Docker adapter, because Floci's Lambdas can't reach the Docker daemon | ~120 lines of transport, guarded by a token |
| Sync goes through the run Lambda, never S3 from inside the sandbox | Every byte crosses the 1 GB Lambda; a 100 MB pull costs seconds at session start |
| Each file version is a fresh S3 object, the DynamoDB item the pointer; uploads land in `staging/` and are copied | One CopyObject per upload; a crash after commit leaves an orphan object |
| Last write wins with a note; a delete removes only the version the run loaded | A run can't force-delete a file another thread just rewrote |
| "Loaded" = the version the session held before this step's pull | A file someone changed between steps is still reported as overwritten, which is the honest answer: the model wrote the code without seeing it |
| Any member can upload, replace and delete room files, behind a confirm | One `can()` check for admin-only deletes |
| Member uploads land in the root under their own names; agents can make folders | Folder uploads would be one path field later |
| AgentCore runs every language as a base64 temp file under `timeout` via `executeCommand` | If its output differs from the fixtures, only `agentcore.ts` changes |
| Two AgentCore interpreters (offline and online), no execution role; the switch picks one at session start | A room switching mid-run waits for its next run |
| The sandbox token is one random file per checkout, baked into the local run Lambda by `deploy:local` | Another checkout's deploy replaces it; redeploy from the checkout whose server runs |
| The local online sandbox is on its own bridge network (`enable_icc=false`) with the host's names pointed at loopback, and only with `SANDBOX_LOCAL_INTERNET=1` | Without the flag, a room's internet switch does nothing locally (the step says so); with it, code can reach this machine (see Known limits) |
| The image is `python:3.12-slim` + node, npm, git and curl, copied onto `scratch` so no base ENV (like `GPG_KEY`) leaks in | 450 MB; a smaller image would drop npm |
| Every `sandbox_run` step is billed (min 1 s), including bad input and a lost session | A broken call costs 61 µ$ |
| DeepSeek never gets `sandbox_run`; the first call taints the thread before exec | A DeepSeek thread can't run code; the user picks another model |
| The local server keeps the last 1 MB of each output stream before the 8,000-character cut | A flood of output costs memory only up to 1 MB per stream |

**Process**
| Ruling | Cost if wrong |
|---|---|
| The pure rules (paths, push plan, notes, cost) first, then Docker, AgentCore and the file store in parallel, then the run loop, then the web | Merge glue around `core-stack.ts` and `knip.json` |
| AgentCore is tested against a mocked `send` only; the live check waits for the first AWS deploy | A payload-shape mismatch shows on the first live call |

## npm dependencies added
| Package | Where | Why |
|---|---|---|
| `@aws-sdk/client-bedrock-agentcore` | services | The Code Interpreter data plane (`StartCodeInterpreterSession`, `InvokeCodeInterpreter`, `StopCodeInterpreterSession`) for the AWS adapter |
| `undici` (^7) | services | The local sandbox client's `fetch` with a 330 s headers/body timeout. Node's built-in `fetch` gives up waiting for headers after 300 s, and a 300 s exec answers just after that. Its own `fetch` is used because Node 22's bundled undici may not accept a v7 dispatcher |

No web dependencies were added: the Files tab uses the existing Motion, lucide icons and the BFF.

## Floci notes
- **No AgentCore on Floci**, so the local run Lambda (`SANDBOX_KIND=docker`) calls the sandbox server at `http://host.docker.internal:4700`. Docker Desktop routes that name from Floci's Lambda containers to the host even though the server binds `127.0.0.1` only, so no `0.0.0.0` bind was needed.
- **Room file S3 calls work:** server-side `CopyObject` (staging → `workspaces/`) keeps bytes and content type, quiet `DeleteObjects` works, and the presigned POST into `staging/` enforces its policy. The `staging/` lifecycle rule (expire after 1 day) is stored and read back, but nobody has watched Floci expire an object.
- **Floci never cancels a transaction with `TransactionConflict`**, so the commit's retry on it is only unit-tested; AWS can cancel one of two transactions on the same `META`.
- **Redeploys can wedge the stack.** Two deploys this step hit "Route with key 'PUT /rooms/{roomId}/…' already exists" → `UPDATE_ROLLBACK_FAILED`. The fix (empty `cl-local-files`, delete `cl-local-core`, deploy again) wipes the user pool, so the full int suite and the smoke ran on a freshly reset Floci.
- **Floci's hostnames need the internet.** `*.localhost.floci.io` resolves to 127.0.0.1 through public DNS, so a network outage mid-run failed 23 int tests and one smoke check with `ENOTFOUND`; the same runs passed once it was back. A third smoke on that Floci, after three int runs and two smokes (a 6.3 MB store), missed two timing checks (the chat slide and a reopen within 15 s); after a reset both smokes passed in full.
- Details are in the [Floci compatibility report](floci-compat.md).

## Known limits
- **A crash during the exec itself reruns the code.** The exec result is stored as soon as the code returns, so a retry after that never reruns it; a Lambda that dies while the code is still running leaves nothing stored, and the retry runs it again in the same session.
- **The orphan-container window.** If the run Lambda dies between starting a session and storing its `SANDBOX` item, the session is orphaned until its own 7,800 s timeout (or, locally, until `sandbox:local` reaps leftover `cl-sandbox=1` containers at its next start).
- **The local online sandbox can reach the host, so it's off unless you opt in.** Floci publishes its port on all interfaces and accepts any credentials, so code in an online container can reach it through the bridge gateway's IP: every local room's tables and buckets, the run Lambda's configuration (its sandbox token, which drives this sandbox server and other runs' sessions) and, after `deploy:local --live-models`, the real model keys in `cl-local-model-keys`, which it could then send out. That is why local sessions run offline unless the sandbox server starts with `SANDBOX_LOCAL_INTERNET=1`. Never combine that flag with `--live-models`. The full fix is an egress proxy on an `--internal` network; on AWS, AgentCore's `PUBLIC` mode has no path to this machine.
- **The AWS adapter can't cap a file read.** Docker reads stop one byte past 25 MB, but AgentCore's `readFiles` returns whole files, so code that leaves a background process growing a file between the listing and the read could exhaust the run Lambda's memory. Only that run suffers.
- **The `SANDBOX` item holds the whole manifest.** At 1,000 files with long non-ASCII names it nears DynamoDB's 400 KB item limit; typical names use a quarter of that.
- **The reaper is machine-wide.** `sandbox:local` removes every `cl-sandbox=1` container at start, including one a Docker int test in another checkout is using at that moment.
- **The file/folder clash check reads before the transaction**, so two concurrent commits of `a` and `a/b` could both land. Guard items per folder would close it.
- **An out-of-memory kill near the time limit reads as a timeout** (both exit 137).
- **Bytes go through the Lambda:** a pull reads up to 8 MB per batch and a push one file (≤ 25 MB) at a time inside the 1 GB run Lambda.

## How big companies do it
- **OpenAI Code Interpreter and Claude's code execution tool:** both run model-written code in a managed, sandboxed container with a working directory of files the user uploaded, and hand files the code wrote back as downloadable outputs, which is this build's room files. OpenAI's container expires after a period of inactivity (state is lost, files must be re-uploaded); Anthropic's code execution tool runs in a container with no internet access, reusable across requests by id for a limited time. Both treat the network as off by default, as here.
- **E2B and Firecracker microVMs:** E2B gives each agent a Firecracker microVM that boots in a few hundred milliseconds, with a filesystem API (`files.write`, `files.read`, `files.list`) and a process API — almost exactly our `Sandbox` interface. Firecracker is the VMM behind Lambda and Fargate; a microVM gives a hardware-virtualisation boundary per tenant, which a plain container (shared kernel) doesn't. AgentCore's Code Interpreter is AWS's managed take on the same idea, with per-session isolation and `SANDBOX` / `PUBLIC` network modes.
- **Replit and GitHub Codespaces:** both give each workspace a long-lived container (Codespaces: a VM per codespace) with a persistent disk, and stop it after idle time. That's the per-thread session we chose not to build: it makes `pip install` stick, at the price of idle billing, a sweeper and snapshot storage. Our "fresh session per run, files restored from S3" is closer to CI runners.
- **Dropbox and Google Drive conflict copies:** two offline edits to the same file make Dropbox keep both, as `report (Aman's conflicted copy).docx`, rather than pick a winner. We pick the latest and *say* so in the step's output, because an agent re-reading the room would be confused by stray copies, and the overwritten author is named.
- **S3 versioning vs. keeping one version:** with bucket versioning on, S3 keeps every object version and a delete adds a marker, so nothing is ever lost but storage grows with every save. We keep one live version per path (the DynamoDB pointer) and delete the old object after the swap, which keeps the 100 MB quota honest and the bill flat; the cost is no undo, which the Replace and Delete confirms say out loud.

## Interview angle
- "How do you let an LLM run code safely?" An isolated sandbox per session with no credentials, no secrets in the environment and no network by default; everything in and out moves through your own service, which applies quotas and records what changed.
- "Two agents edit the same file at once. What happens?" Each version is a new object; the pointer swap is conditioned on the version read. The later write wins, and its step names the overwritten author; a delete only removes the version it saw.
- "How do you enforce a storage quota under concurrency?" Keep running totals next to the data and change them with a conditional `ADD` in the same transaction as the write, so the check and the update are one atomic operation.
- "Your Lambda retries a step that started a container. Do you leak one?" The session is stored with a conditional put; a retry that loses the put stops its own container and reuses the stored one, and every session also has its own deadline.
- "How do you test against a managed service you can't run locally?" One narrow interface, a local substitute behind it (Docker here), the managed adapter tested against recorded shapes, and one live check before launch.
