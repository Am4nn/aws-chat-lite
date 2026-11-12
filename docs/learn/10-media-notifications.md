# Step 10: Media and notifications

## What we built
- **Image understanding.** An image attached to a thread message or a steer (`png`, `jpeg`, `gif`, `webp`) reaches Claude as an image block, not just as `[attached: shot.png]`. The newest 20 images go along, each at most 3.75 MB and 15 MB in all; anything bigger, anything whose bytes aren't the image type they claim, and anything over 8,000 px on a side is named in the text only. DeepSeek never gets image bytes.
- **Images.** An `image_generate` tool draws with Gemini (`gemini-3.1-flash-image`, 1K, aspect `1:1`, `3:4`, `4:3`, `9:16` or `16:9`). The picture is saved as a room file, `images/<thread>-<run>-<step>-<first four words>.png`, and shows on its step row and in a gallery under the answer, fading in once decoded inside a box that already has its shape. Clicking opens it full size. Each image is billed at Gemini's own token counts (about $0.067), and `images` is a new agent tool kind: on for `@agent`, offered in every room, an **Images** box in the agent form.
- **Dictation.** Every composer has a mic. Up to 60 s of speech streams to Amazon Transcribe; the strip above the box shows `0:07 / 1:00` and the words so far, and the transcript lands in the box for editing (it never sends itself). Esc cancels. The room's budget reserves a minute when you start and refunds the unused seconds when you stop.
- **Read aloud.** Every stored agent answer has a speaker button (`Read aloud` / `Stop reading`). Polly's neural voice Matthew reads the first 10,000 characters, with code blocks skipped. The MP3 is cached in S3 for 30 days, so a second play by anyone in the room costs nothing.
- **Web push.** One switch in the room menu, `Notifications: off · Turn on`. You get a notification when you're @mentioned (or `@everyone`, or added by an edit), when a run you started ends (`#12 finished`, `#12 failed`, `#12 stopped: the room's budget is used up`, `#12 was stopped by bea`), and when any run in the room needs an approval (`#12 needs approval`). A click opens the chat or thread. Nothing shows when a visible tab is already on that page, except on Apple's push service, where Safari would revoke a subscription that shows nothing. Signing out turns push off on that device.
- **An installable app.** A web manifest and icons, so chat-lite can be added to a phone's home screen. On iPhone that is the only way to get web push; the menu row says so: `On iPhone, add chat-lite to your Home Screen first`.
- **`npm run smoke`** gained 7 checks (`scripts/src/smoke-media.ts`), on the fakes, with Chrome's fake microphone:
  1. an attached PNG reaches the model as an image (the fake answers `(saw 1 image)`);
  2. `call:image_generate` saves `images/…png`, the thread shows it, Files lists it, and the run costs at least $0.067;
  3. Read aloud fetches an `audio/mpeg` file and the button turns into `Stop reading`;
  4. dictation types `this is a fake transcript` into the box, and the budget moves by 167 µ$ for each second spoken;
  5. B's `@A hi` queues a push for A titled `B mentioned you in #general`;
  6. the service worker shows a push meant for another page and holds back one for the page that's open;
  7. at 390×844 the dictation strip and the gallery fit with no side scroll, and under reduced motion the strip has 0 animated frames.

  The smoke found that under reduced motion the dictation strip still started at opacity 0 for a frame or two; it now appears at once (`initial={reduced ? false : …}`, as the approval card does). One step 9 check unticked only Sandbox for its web-only `@researcher`, and a new agent now starts with Images ticked too. The whole smoke passed 122/122 twice in a row on a fresh Floci. It runs on `http://localhost:3000` (the default `WEB_URL`): the OAuth consent redirect goes to the first site origin, so a smoke on :3100 fails at the MCP sign-in.

## How to try it
```powershell
npm run deploy:local                              # fake Gemini, fake Polly, fake Transcribe, fake push sender
npm run deploy:local -- --live-models             # real models and Gemini: copies 4 keys from .env (GEMINI_API_KEY too)
npm run deploy:local -- --live-push               # real push services; fails fast unless .env has the three VAPID_* keys
npm run dev                                       # the web app, the run stream, the sandbox, the MCP test server and the fake Transcribe (ws://localhost:4601)
$env:REAL_MODELS='1'; npm -w services run test:live -- images   # one real Gemini image (about $0.07)
$env:REAL_AWS='1'; npm -w services run test:live -- voice       # Polly and Transcribe, on AWS only
```
- On the fake model, `call:image_generate` draws (the fake Gemini returns a 1×1 PNG billed as one 1K image; a prompt with `refuse` in it is declined), and any answer to a message with an image attachment says `(saw 1 image)`.
- The fake Transcribe answers every half second of audio with one more word of `this is a fake transcript of what you said`; the fake Polly returns a second of silent MP3.
- Push keys: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in `.env` (make a pair with `npx web-push generate-vapid-keys`). `deploy:local` stores them whenever they're there, so the switch appears; sends stay fake (`PUSHED#` items on the user) unless `--live-push`. Test push on `http://localhost:3000`, not a LAN address: a service worker needs a secure context, and `localhost` counts as one.

## How a push travels
```mermaid
sequenceDiagram
  participant P as producer (chat send, run finish, approval)
  participant W as cl-<stage>-push (async invoke, 0 retries)
  participant T as table
  participant S as push service (FCM, Mozilla, Apple, WNS)
  participant SW as the device's service worker
  P->>W: Invoke InvocationType=Event {kind, roomId, userIds…}
  W->>T: room, chat or thread; current members; their devices
  W->>W: the copy: title, body, url, tag, urgency
  W->>S: POST endpoint (RFC 8291 encrypted, VAPID JWT, TTL 3600, Topic)
  S-->>W: 201, or 404/410 for a gone device (deleted)
  S->>SW: push event
  SW->>SW: a visible tab on that url? then nothing (except Apple)
  SW->>SW: showNotification(title, {body, tag, data: {url}})
```

## The patterns
**Multimodal input under a privacy rule, with defence in depth.** The context builder puts image *references* (key, type, size) on user messages; only `loadImages`, right before a model call, reads the bytes from S3, and only for a model that may see private content. The Anthropic adapter then throws if a DeepSeek request carries image data at all, so a missed taint check fails loudly instead of leaking. Images go as base64 blocks rather than URLs: a presigned URL would let the provider fetch from our bucket on its own schedule, and base64 keeps "what left" exactly what we sent. The bytes are sniffed, not trusted: the type comes from the magic number, and the header gives the size, so a JPEG named `.png` or a 12,000 px screenshot is named instead of poisoning every later turn with a provider 400.

**An image tool with idempotent staging under at-least-once retries.** A durable step can run again after a crash, and Gemini bills every call, so the step leaves a trace after each part and skips what it finds:
1. the bytes go to `generated/<runId>/<step>` with Gemini's cost as S3 user metadata, *before* billing;
2. a `usage` event with `job: "image"` and the step bills it, once (the step's own check);
3. the file is copied into the room's files and committed, and the step's `files.synced` says so.

A retry that finds the staged object bills from its metadata without calling Gemini again; one that finds a charge but no object knows Gemini failed and says so; one that finds `files.synced` just answers. Step numbers are the run's, not a helper lane's, so the keys never meet. The file name carries the run (its first message's seq), so "again, but watercolor" never replaces the first picture, and the name is the same on a retry, which then finds its own file.

**A presigned WebSocket for streaming speech-to-text.** The browser streams audio straight to Transcribe; no Lambda sits in the audio path. The voice Lambda signs a `wss://transcribestreaming.<region>.amazonaws.com:8443/stream-transcription-websocket?…` URL with SigV4 query signing (5 minutes to connect) using its own role, so the browser holds a signature and a session token, never a secret key. The browser captures the mic with an `AudioWorklet`, downsamples to 16 kHz mono 16-bit PCM, and wraps each 100 ms in an AWS event-stream frame (binary headers, body, CRCs); an empty audio event ends the stream and asks for the final results. Partial results share a `ResultId` and replace each other; a final one is appended. Locally a Node server speaks the same frames on `ws://localhost:4601`, so the browser code is the one that ships.

**Reserve, then refund.** The server can't see a stream it isn't in, so it can't meter it. Instead it reserves the most a dictation may cost (60 s × 167 µ$ = 10,020 µ$) in the same transaction that creates the session, refusing when the room has less left, and `done {seconds}` refunds the difference: `billed = min(ceil(seconds), 60, ceil(seconds since the URL was signed))`. The refund lands in the month of the reservation, and a second `done` is refused by a conditional write. The cost of trusting the client is bounded and written down (see Rulings).

**Two dictation engines behind one hook, chosen per stage.** The AWS account is on the free plan, whose service control policy denies `transcribe:StartStreamTranscriptionWebSocket` with an explicit deny that no IAM policy can override, so the aws stage dictates with the browser's Web Speech API (`webkitSpeechRecognition`, continuous, with interim results, in the browser's language) and local keeps Transcribe, which the fakes and the smoke exercise. `dictation: "browser" | "transcribe"` in `infra/lib/config.ts` reaches the Next.js server as `DICTATION`, the room layout hands it to every composer through a context, and the composer calls one `useDictation` that returns the same shape from either engine. The voice Lambda, its routes and the Transcribe path all still deploy, so flipping the setting back is the whole change once the account is on a paid plan.

| | Browser | Transcribe |
|---|---|---|
| Cost | Nothing, so no reservation, no refund, no voice API call | 167 µ$ a second, reserved and refunded on the room's budget |
| Who hears the audio | The browser's vendor: in Chrome, Google's servers (the `?` beside the mic says so) | AWS only, in the stack's region |
| Where it works | Chrome, Edge and Safari; Firefox has none, so the mic is hidden there | Any browser with an `AudioWorklet` |
| Metering | None to trust or abuse | Client-reported seconds (see Rulings) |

Either way, a user only ever reads one of a few fixed messages (`Allow the microphone to dictate.`, `Didn't catch anything. Try again.`, `Dictation stopped. Try again.`, `Dictation isn't available right now.`). The real cause goes to the console: Transcribe's refusal under the free plan names the voice role's ARN, which once showed in the strip.

**Text to speech in chunks, cached per answer.** Markdown becomes speech text (a code block becomes " (code block skipped) ", a link its text, a bare URL "a link"), cut at 10,000 characters on a sentence boundary, then split into chunks of at most 2,800 characters (Polly takes 3,000 a request) at sentence ends, synthesized 4 at a time and joined: MP3 frames simply concatenate. The cost is recorded before the S3 put, and the result is stored at `speech/<room>/<chat>/<seq>.mp3`; a play checks for it first with HeadObject, which answers 403, not 404, for a missing key when the caller may not list the bucket. Agent answers are never edited, and a removed one answers 410, so the cache can't go stale.

**Web Push: three RFCs and a service worker.** RFC 8030 is delivery: the browser's push service (FCM for Chrome, Mozilla's for Firefox, Apple's for Safari, WNS for Edge on Windows) gives each subscription an endpoint URL; the server POSTs to it with `TTL`, `Urgency` and a `Topic` (a newer message with the same topic replaces an undelivered older one). RFC 8291 encrypts the payload end to end with the subscription's P-256 key and auth secret, so the push service carries ciphertext. RFC 8292 (VAPID) signs a JWT with the server's key pair, so only our server can push to subscriptions made with our public key. The service worker receives the event even with every tab closed; Chrome requires each push to show something (`userVisibleOnly`), and Safari quietly revokes a subscription that doesn't. On iPhone, web push exists only for a site added to the home screen (iOS 16.4+), and the permission prompt must come from a tap.

**Fire-and-forget async invokes with retries off.** Producers never wait on push: `enqueuePush` is a Lambda `Invoke` with `InvocationType: "Event"` (202, queued by Lambda), best effort, and an error is logged, not raised. The worker's async config sets 0 retries and a 5-minute maximum age, because a notification that arrives twice or an hour late is worse than one that never arrives. A dead device (404 or 410) is deleted on the spot.

**An allowlist against SSRF on user-given URLs.** A push endpoint is a URL a browser hands us, and the worker POSTs to it. It must be `https:` on the default port, with no user info, and its host must be exactly `fcm.googleapis.com`, `updates.push.services.mozilla.com` or `web.push.apple.com`, or end in `.push.apple.com` or `.notify.windows.com`; the keys must decode to a 65-byte point starting `0x04` and a 16-byte secret. Anything else is a 400 at save time, so the worker never connects to an address a user chose.

**Least privilege for keys, split by who needs them.** The VAPID private key lives in `cl-<stage>-push-keys`, read only by the worker. The routes facing browsers read `cl-<stage>-push-public-key` alone. Both secrets start as `{"unset": "…"}` (CloudFormation's `GenerateSecretString` with a `{}` template), so a stack with no keys answers `GET /push/key` with `{publicKey: null}` and the switch stays hidden, instead of a 500 from a random placeholder. A secret read whose value isn't JSON, or lacks a needed field, isn't cached, so keys put in later take effect on warm containers.

## What the final review changed
- **A second run in a thread overwrote the first run's image.** Steps restart at 1 in every run, so "again, but watercolor" wrote the same `images/7-1-…` path and deleted the picture the first answer showed. The path now carries the run's first message seq.
- **One image Claude couldn't read killed the thread.** A JPEG named `.png`, or a tall screenshot over 8,000 px, got a 400 from the API on every later turn, because every turn resends the thread's images. The bytes are sniffed now (type and size from the header), and such an image is only named.
- **Read aloud's first play would fail on iPhone and Safari.** WebKit lets audio start only from a tap, and the button waited for Polly before calling `play()`. The click now starts the shared audio element on a 1 ms silent WAV at once, and the real MP3 plays on that unlocked element. This still needs the hand check on an iPhone (below).
- **`GET /push/key` was a 500 on every app open** with no keys (the secret held a random password, not JSON), and keys put in later stayed broken on warm Lambdas. Fixed as described under the last pattern.
- **The push routes could read the VAPID private key.** They now read a public-key secret of their own.
- **A dictation was charged before its URL was signed,** so a signing failure billed a minute that could never be refunded. It signs first now.
- **A generated image that failed to load stayed an empty box,** and its full-size link expired after an hour. It says `This image couldn't load.`, and the link is signed again every 50 minutes.
- **One browser shared by two accounts** kept sending A's notifications after B signed in. Signing out turns push off, and saving an endpoint another user holds takes it over (`PUSHENDPOINT#<id>` owner item).

## Rulings
| Ruling | Cost if wrong |
|---|---|
| **Dictation streams from the browser to Transcribe on a presigned WebSocket,** reserved at 60 s and refunded to what the client reports. **For Aman:** a member who rewrites the client can report fewer seconds, or keep one URL streaming up to Transcribe's 4 h session limit (≤ about $2.40 at 167 µ$/s, ≤ 20 URLs an hour per member), past the room cap (planned as ≤ $5.76 at the US rate; $2.40 at the Sydney rate). Members are invited people; the alternative is record → upload → transcribe in a Lambda, which meters exactly but makes you wait about as long as you spoke | A hostile member can run up Transcribe cost past the cap |
| Transcribe in Sydney is 167 µ$/s ($0.01/min, per second, no minimum), from the AWS Price List API on 2026-11-11; Polly neural is 16 µ$/char | Re-check whether $0.01/min is the first usage tier; off by ≤ 0.014 $ per dictation |
| Images go to every model that has the `images` kind, DeepSeek included, and a prompt from a private thread goes to Gemini: the privacy rule bars only DeepSeek, and the image never goes back to the model | If Gemini should stay away from private threads, `toolsFor` needs one taint check |
| A helper working for DeepSeek keeps `images` (and the web): an image step returns only a path, so nothing private enters the thread | A DeepSeek-led helper can send Gemini a prompt drawn from its task |
| A helper's images show under the main answer (the answer's gallery is every lane's) | None known |
| Images can overshoot the budget by one image (≤ $0.07), as model calls overshoot by one call | One image past the cap |
| Gemini: a timeout or 503 costs nothing and says `Gemini is busy`; any 200 reply is billed, from its token counts or else 67,000 µ$ | A timed-out call Gemini finished is billed by Google but not here |
| Vision sends the newest 20 images that fit (3.75 MB each, 15 MB in all), sniffed for type and size; a rejected one frees no slot for an older one | One fewer image in a thread with more than 20 and a bad one |
| Read aloud covers stored agent answers only, the first 10,000 characters, cached 30 days; any member may play it | Two members clicking the same new answer at once can both be billed (≤ $0.16) |
| Push goes to the mentioned members, the run's starter when a run ends (none when they stopped it themselves), and every member for an approval | A busy room gets more approval pushes |
| Push delivery is an async invoke with 0 retries and a 5-minute maximum age | A push service hiccup loses that notification |
| The service worker shows nothing when a visible tab is on that page, except on Apple's push service | An iPhone user looking at the chat still gets the banner |
| Sign-out turns push off on that device, and a saved endpoint moves to the user who saved it last | One extra tap per sign-in to turn it back on |
| Scheduled runs start as the `schedule` author, so a scheduled run's end pushes no one; mentions in its card and prompt do push | A schedule's creator gets no "finished" ping |
| Push keys are stored whenever `.env` has them; sends are fake unless `--live-push` | None: VAPID costs nothing |

## npm dependencies added
- **services:** `web-push@^3.6.7` (with `@types/web-push`; 4.0.0 was days old, ESM-only and didn't match its types), `@aws-sdk/client-polly`, `@smithy/signature-v4`, `@smithy/hash-node` and `@aws-sdk/credential-provider-node` (the presigned Transcribe URL), and as dev dependencies `@smithy/eventstream-codec` and `@smithy/util-utf8` for the voice live suite.
- **web** and **scripts:** `@smithy/eventstream-codec` and `@smithy/util-utf8`, the event-stream frames on both ends of the socket.
- Gemini is plain `fetch`, with no SDK.

## The live run
One Haiku thread on Floci (`deploy:local -- --live-models --live-push`, 2026-11-12), the room's budget set to $0.05 first so the run could make one Gemini call and no second:
- **The image.** `Call image_generate exactly once with the prompt "a small lime-green paper boat on dark water, flat illustration"…`. Haiku called the tool once; Gemini answered with a 1024×1024 **JPEG** (622 KB), not a PNG, saved as `images/1-1-1-lime-green-paper-boat.jpg` and shown in the gallery. Gemini's own counts: 14 prompt tokens, 1,501 output tokens (1,120 image, 381 text and thinking), billed **68,350 µ$**. The run then ended `capped` at the room's $0.05, as intended.
- **Vision.** The same JPEG attached to the thread with `What is in the image I just attached?`: Haiku answered "A lime-green paper boat floats on dark, wavy water under a night sky with a crescent moon, stars, and silhouetted trees and hills." — so the bytes reached it as an image block. The image's tokens show up as a cache write (1,431 tokens) behind a 1,465-token cache read; the turn cost 219 µ$.
- **Push.** Turning the switch on in headless Chrome made a real FCM subscription; a mention sent it through FCM from Floci's Lambda, and a made-up FCM endpoint was answered as gone and deleted. The headless browser never received the push, so the banner on a phone is still Aman's check below. No real device got a push.
- **Spend:** **$0.0689** (68,908 µ$): naming 94, Haiku 245 + 219, Gemini 68,350. Afterwards the stack was redeployed plain and `cl-local-model-keys`, `cl-local-tool-keys`, `cl-local-push-keys` and `cl-local-push-public-key` were set to `{}` (read back `{}`).

## Floci notes
- **The first full int run on a fresh Floci passed 302/303** (32 files, the step's vision, media, push repo and voice repo files included). The one failure was an older storage test expecting `HeadObject`'s old shape; it now also pins that **S3 user metadata round-trips on Floci**, which the image step's retry depends on.
- **Secrets created with `GenerateSecretString` and a `{}` template** start as `{"unset":"…"}`, so a fresh stack's `GET /push/key` is `{publicKey: null}`, and after `deploy:local` stores the keys, the same warm Lambda returns the real key (the routes Lambda's environment holds only `PUSH_PUBLIC_KEY_SECRET`).
- **Async invokes:** the push worker's `EventInvokeConfig` (0 retries, 300 s) deploys, and an `InvocationType: "Event"` invoke reaches it from the live Lambda (a mention over the socket, in the smoke) and from the run (run end and approval pushes, in the media int test).
- **Floci's Lambdas reach FCM,** and FCM's "gone" answer for a made-up endpoint deleted that device. Headless Chrome can make a real subscription only in its default (non-incognito) context and never receives the push itself.
- **Transcribe and Polly are faked, not emulated:** a local event-stream server on `ws://localhost:4601` and a silent-MP3 speaker.
- **Headless Chrome keeps no notifications** (`getNotifications()` is always empty), so the smoke records the service worker's `showNotification` calls instead; and **Motion reads reduced motion when the page loads**, so the smoke emulates it before opening the page.
- Details are in the [Floci compatibility report](floci-compat.md).

## Checks for Aman, by hand
- **Read aloud on an iPhone (Safari, and the home-screen app).** Open a thread with an answer, tap the speaker: the answer should start reading within a few seconds on the *first* tap after loading the page, and the button should show the square. Tap again to stop, then tap a second answer: the first stops, the second plays. If the first tap gives an error toast (`NotAllowedError`), the silent-unlock fix didn't hold on that iOS version. Do the same in desktop Safari.
- **A real web push to your phone.** Put the VAPID keys in `.env`, `npm run deploy:local -- --live-push`, open the app on the phone (on iPhone: Share ▸ Add to Home Screen, then open it from there), turn on `Notifications` in the room menu, lock the phone, and from another account `@you hi`: a banner `<them> mentioned you in #general` should arrive within seconds, and tapping it should open that chat. Then start a run and let it finish (`#n finished`), and turn the switch off: no more banners. A LAN address isn't a secure context, so the phone needs the deployed AWS stack (step 11) or a tunnel with https.
- **Transcribe and Polly on AWS (step 11).** `$env:REAL_AWS='1'; npm -w services run test:live -- voice` with credentials that may call both in `ap-southeast-2`; then dictate in the deployed app and check the words appear live and the budget moves by about 167 µ$ per second. The presigned host, port 8443 and frame headers are only provable there.
- **Re-check the Sydney prices** on the Transcribe and Polly pricing pages (the first usage tier, and whether streaming has a per-request minimum).

## Known limits
- **Voice metering trusts the client** (see Rulings): exact only for our own browser code.
- **`en-US` only** for Transcribe dictation (the browser engine uses the browser's language), and Matthew only for reading; another language needs a picker (one query parameter each).
- **No image editing:** the tool is text to image. Editing an attachment would send its bytes to Gemini, a separate privacy decision.
- **A push can be lost** (no retries) and a lock screen shows the message excerpt or run summary, even for a private thread.
- **Old runs send no end push:** runs from before this step have no `startedById`.
- **The push worker's retry setting is trusted, not watched:** Floci stores `MaximumRetryAttempts: 0`, but AWS's retries come a minute or more later, which no local test waits for.

## How big companies do it
- **Slack and Discord notifications:** a fan-out service resolves who should hear about a message (mentions, keywords, per-channel settings), then sends through FCM and APNs per device token, and drops tokens the push service reports as gone. Slack also holds back a push while you're active on the desktop, as our service worker does for a visible tab.
- **ChatGPT dictation versus its voice mode:** dictation records, then transcribes in one request (exact metering, a wait at the end); voice mode streams both ways over WebRTC for a live conversation. We stream for the live words and pay for it with client-reported metering.
- **Google Meet live captions:** streaming recognition with interim results that rewrite themselves until a final one is fixed, the same partial-then-final shape as Transcribe's `IsPartial`.
- **Claude.ai image inputs:** images go to the model as base64 or file references, with size and dimension limits checked before the call; an oversize image is resized client-side. We skip what doesn't fit instead (resizing would need a native dependency).
- **ChatGPT image generation:** each image is an artifact in the conversation that can be downloaded and iterated on ("make it watercolor"); ours is a room file under `images/`, which the sandbox and later turns can use by path.

## Interview angle
- "How do you let a cheap model and an expensive one share a chat when only one may see images?" Carry references in the context, fill in bytes only at the last step for a model that may see them, and make the provider adapter refuse image data for the other one, so a missed check fails loudly.
- "A durable step calls a paid API. How do you make retries safe?" Stage the result with its cost before billing, bill with a check keyed by the step, commit with a marker; on retry, resume from the last trace instead of calling again.
- "How would you stream audio from a browser to a speech service without proxying it?" A SigV4-presigned WebSocket URL from your backend, signed with a short-lived role, and the AWS event-stream framing in the browser. Then decide how to meter what you can't see: reserve the maximum, refund on report, bound the abuse.
- "How does web push work end to end?" Subscription (endpoint + keys) from the browser's push service, VAPID-signed POST with an RFC 8291-encrypted payload, a service worker that must show something, and cleanup of gone subscriptions. On iPhone, only for home-screen apps.
- "A user gives you a URL your server will call. What do you check?" Scheme, port and an exact host allowlist at save time, not a denylist of private ranges; then nothing a user typed can make your worker connect to your own network.
