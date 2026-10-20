# svc-notify

Event-driven notification fan-out for `ops.notifications`. Bus events become
inbox rows, and inbox rows are then attempted on every channel for which the user
has confirmed an address.

This service holds no balances and posts no ledger transactions.

## The one thing to understand

**An attempt and an outcome are two different facts, and this service never
collapses them.** Every (notification, channel) pair gets a row in
`notify.deliveries` carrying both:

| Column         | Means                                    |
| -------------- | ---------------------------------------- |
| `attempted_at` | we handed it to a transport              |
| `accepted_at`  | a transport accepted it **for delivery** |
| `refusal_code` | why we did not even try                  |

So these three situations stay distinguishable, forever, from the record:

- **a transport took it** — `attempted_at` and `accepted_at` both set
- **we tried and it did not work** — `attempted_at` set, `accepted_at` null
- **we never had anywhere to send it** — both null, `refusal_code` says which

A database CHECK enforces `accepted_at IS NOT NULL` exactly when
`status = 'accepted'`, so no future bug can quietly make an undelivered margin
call read as a delivered one. svc-bank keeps `notified_at` apart from `called_at`
for the same reason; this is that discipline one layer out.

### `accepted`, not `delivered` — and why the column was renamed

The column used to be called `delivered_at`, and it was set the moment a gateway
answered 2xx. **A gateway answering 2xx has taken custody of the message.** It
has not said the mail server took it, that the handset was reachable, or that a
human read it — and this service receives no delivery receipts, so it never
learns any of those things.

`accepted` is the strongest statement the code can support, so it is the word
the status and the column use (migration `0002_notify_delivery_accepted`).

This is not pedantry. svc-bank stamps a margin call `notified_at` and runs the
liquidation grace clock off that stamp. A word that decides whether somebody's
collateral is sold must mean exactly what it says, and nothing downstream should
read `accepted` as "the borrower knows".

## Channels

Four channels, one interface (`NotificationChannel`, Doctrine §0.4).

| Channel | Transport                              | Needs                                                     |
| ------- | -------------------------------------- | --------------------------------------------------------- |
| `inapp` | the inbox row itself                   | nothing — always available                                |
| `email` | authenticated POST to a configured URL | `NOTIFY_EMAIL_GATEWAY_URL` + `NOTIFY_EMAIL_GATEWAY_TOKEN` |
| `push`  | authenticated POST to a configured URL | `NOTIFY_PUSH_GATEWAY_URL` + `NOTIFY_PUSH_GATEWAY_TOKEN`   |
| `sms`   | authenticated POST to a configured URL | `NOTIFY_SMS_GATEWAY_URL` + `NOTIFY_SMS_GATEWAY_TOKEN`     |

### Mountain vs §13 sockets (D26-P1-O5)

| Tracker id            | Plane                 | What it means                                                                                                                               |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops.notifications`   | **Fan-out mountain**  | Bus → inbox → delivery rows. In-app **delivers**. Status stays `ready`, not `done`, while every out-of-app channel refuses in real deploys. |
| `socket.notify-email` | §13 credential socket | Adapter shipped; refuse `channel.not_configured` until Class X credentials.                                                                 |
| `socket.notify-push`  | §13 credential socket | Same.                                                                                                                                       |
| `socket.notify-sms`   | §13 credential socket | Same.                                                                                                                                       |

`notify.channels` and `GET /ready` carry `socket` on each channel status: `null`
for `inapp` (mountain surface), `socket.notify-*` for the three out-of-app
channels. Machine matrix: `src/channels/mountain-vs-sockets.ts`. Closing a
socket is owner work — [`docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`](../../docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md)
— never inventing a provider name in code (§0.7).

**A channel with no credentials is registered, not omitted.** It refuses every
message with `channel.not_configured`, the refusal lands on the delivery row, and
`GET /ready` and `notify.channels` both name the environment variables that are
missing. Nothing is dropped in silence and nothing reports a send that did not
happen.

**URL+token is configured, not reachable.** `/ready.channels` and `notify.channels`
report `configured: true` and `reason: channel.unprobed` until a POST proves a
2xx. This process does not probe at boot. `available: true` is `inapp` only.

**A channel the deployment DEPENDS ON is a different case, and it is fatal.**
`NOTIFY_REQUIRED_CHANNELS` lists the out-of-app channels this deployment cannot
do without; anything on it whose pair of variables is missing stops the boot,
naming the variable. In `APP_ENV=staging|prod` the variable itself has no default
and its absence stops the boot too — write `none` to record "in-app only, on
purpose". Same posture as `EDGE_PRINCIPAL_SECRET`, for the same reason: an
honest refusal on every message is still a silent outage if nobody reads the
delivery table. Dev and test require nothing, so no gateway is needed to run the
stack or the suite.

**No provider is named anywhere in this service** (§0.7). The transport is a URL
and a bearer token the owner sets; whoever answers that URL — a mail relay, a
push service, an SMS aggregator, the owner's own forwarder — is configuration.
That also makes changing provider an env change rather than a release.

What the owner has to obtain, in plain language:
[`docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`](../../docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md).

### The gateway contract

Every channel sends the same request shape and differs only in the body:

```
POST <gateway url>
authorization: Bearer <token>
idempotency-key: <notificationId>:<channel>
content-type: application/json
```

| Channel | Body                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------- |
| `email` | `channel, notificationId, to, locale, severity, kind, subject, text, href, titleKey, bodyKey`  |
| `push`  | `channel, notificationId, to, locale, severity, kind, title, body, titleKey, bodyKey, data{…}` |
| `sms`   | `channel, notificationId, to, locale, severity, kind, text, titleKey, bodyKey`                 |

`push.data` carries `{ href, kind, notificationId }` — the routing facts the app
needs to open the right screen, kept out of the two fields a push service shows a
user.

Copy arrives **already rendered**, server-side, from `@intafaced/i18n` — so an
out-of-app message can never carry copy a screen could not (§9) or copy the brand
scan has not seen (§0.7). The keys ride along for a gateway with its own
templates.

**Addresses are validated per channel before anything is sent.** A mailbox with
no domain, a phone number that is not E.164, a device token containing
whitespace: all refused with `channel.target_unroutable`, and no request is made.
A gateway handed a local-format number still sends it somewhere, and which
country that somewhere is in is the carrier's guess, not ours.

**SMS is composed and capped.** One `text` field, `title: body href`, cut to
`NOTIFY_SMS_MAX_CHARS` (480 — three GSM segments) from the body outwards so the
fact and the link survive. SMS is billed per segment; an unbounded body is an
unbounded bill.

**Responses.** Any 2xx is acceptance; `{"id": "..."}` is stored as the reference,
and a 2xx with no body is accepted with a null reference. 408 / 425 / 429 / 5xx
are retried. Other 4xx are not — including **401 / 403, deliberately**: a rejected
credential rejects every message, so retrying turns one bad token into three
times the traffic against somebody's auth endpoint and a plausible IP block.
A redirect is **not followed** (`redirect: 'error'`), so the bearer token never
reaches a host the owner did not configure.

**Retries are bounded by `NOTIFY_MAX_DELIVERY_ATTEMPTS` and by nothing else.**
The adapters contain no retry loop of their own — the bound lives in the
`notify.deliveries` claim, which is in the database and therefore survives the
process dying mid-attempt. `src/channels/gateway-wire.test.ts` counts the
requests **at the server** to prove it, because an attempt counter we keep
ourselves is exactly the number that would still look right if an adapter
retried underneath it.

## Addresses

svc-notify owns `notify.channel_targets`. It does **not** read
`identity.users.email` — §2 forbids reaching into another service's tables, and a
login address is not consent to be texted.

Registering an address sends a six-digit code **through the channel being
registered**, which proves the address belongs to the user and proves the channel
works in one step. Nothing is ever sent to an address whose `verified_at` is
null, and changing an address clears its confirmation.

If the channel has no credentials, registration still records the address and
returns `{ status: 'refused', code: 'channel.not_configured' }` — the truth,
rather than a green tick over silence.

## API

### Guest outreach emails

`guestNotifications.send`, `get`, and `eraseSubmission` are **POST mutations**
restricted to authenticated `svc-ops` with v2 signatures over the exact body.
Configure a dedicated `NOTIFY_OPS_SERVICE_SECRET` (at least 32 characters), shared
only with the ops producer and distinct from `EDGE_PRINCIPAL_SECRET`. Absence
leaves guest ingress closed. Configuring it requires migration
`0009_guest_notifications.sql` at boot. The installed Fastify tRPC parser retains
the original JSON string; the owned ingress adapter verifies those exact bytes
and refuses parsed objects without retained bytes. GET is not a signed lookup.

Ops derives the recipient from the original saved submission, even after a CRM
contact merge. Guest email neither looks up identity by email nor creates/verifies
a platform channel target. Existing platform notifications still require their
confirmed targets. Allowed purposes are contact acknowledgement, staff-authorized
information request, reviewed call invitation and follow-up. Four fixed English
wrappers from `@intafaced/i18n` (`notify.outreach.<kind>.title/body`) render the
messages; callers cannot supply a subject, HTML, template or link. A missing
catalog key refuses before any transport attempt.
The acknowledgement says **contact details received**, never questionnaire complete.
No continuation capability is placed in a message, URL or log.

The owned guest queue commits the immutable business key, normalized request/hash
and claim before handing a message to the transport. Concurrent callers and
replicas share the claim. A conservative monotonic dispatch budget starts before the claim transaction; a delayed commit receipt cannot restart it. Before handoff, the remaining lease must cover the delivery timeout, otherwise the claim becomes unresolved without invoking the transport. Accepted duplicates return the original receipt.
Changing recipient or content under the same key refuses `guest.request_conflict`.
URL/token configuration is not reachability; `accepted` is gateway acceptance,
never delivery or human receipt. Error bodies are discarded; only bounded opaque
references can be retained. Operational results contain IDs, times and typed codes.

There is **one transport attempt per business request**. A timeout, lost response,
ambiguous HTTP failure or expired process claim becomes `unresolved` with
`guest.acceptance_unknown`. Acceptance followed by a failed SQL write retains the
claim; expiry becomes unresolved after restart. Such a request is never blindly
resent, even though the existing gateway sends an idempotency header. No verified
provider dedupe/acceptance-lookup capability is configured by this change; staff
must resolve uncertainty with gateway evidence. A permanent rejection is refused.
Only a known pre-attempt configuration/kill-switch or recipient-budget refusal can
resume the identical request safely. Ops owns the durable producer outbox/worker.

The recipient budget defaults to **3 attempts per 15-minute fixed window**, shared
in PostgreSQL across replicas. `NOTIFY_GUEST_ADDRESS_MAX_PER_WINDOW` and
`NOTIFY_GUEST_ADDRESS_WINDOW_MS` configure it. Duplicate claims spend no new budget.
Only a recipient hash is stored in budget rows, and old windows are pruned on send.

`eraseSubmission` purges recipient/staff text and any gateway reference while
retaining the minimum business hash and outcome. It records an immutable submission
tombstone and replays the original UUID request receipt. A live attempted claim
refuses `guest.delivery_in_progress`; settle it or let its bounded lease expire
before retrying. Erased submissions cannot enqueue further messages. Erasure covers
notify's owned records; ops owns submission/contact erasure and authorization.

| Procedure                | Scope          | Input                                                                           | Output                                                                                                                                                                                                               |
| ------------------------ | -------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`                 | public         | —                                                                               | `{ ok, service, fanoutEnabled, venueIncident }` — `ok` is liveness; `venueIncident.allFine` is the venue claim                                                                                                       |
| `notify.list`            | `notify:read`  | `{ cursor?, limit?, unreadOnly? }`                                              | `{ items, nextCursor }`                                                                                                                                                                                              |
| `notify.unreadCount`     | `notify:read`  | —                                                                               | `{ count }`                                                                                                                                                                                                          |
| `notify.markRead`        | `notify:write` | `{ ids: uuid[] }`                                                               | `{ marked }`                                                                                                                                                                                                         |
| `notify.markAllRead`     | `notify:write` | —                                                                               | `{ marked }`                                                                                                                                                                                                         |
| `notify.channels`        | `notify:read`  | —                                                                               | per-channel availability + missing env + §13 `socket` id (null for in-app)                                                                                                                                           |
| `notify.targets`         | `notify:read`  | —                                                                               | the caller's registered addresses                                                                                                                                                                                    |
| `notify.registerTarget`  | `notify:write` | `{ channel, address, locale? }`                                                 | `{ status, channel, code, expiresAt }` — rate-limited (`channel.register_rate_limited`)                                                                                                                              |
| `notify.verifyTarget`    | `notify:write` | `{ channel, code }`                                                             | `{ verified, code }` — rate-limited (`channel.verify_rate_limited`)                                                                                                                                                  |
| `notify.removeTarget`    | `notify:write` | `{ channel }`                                                                   | `{ removed }`                                                                                                                                                                                                        |
| `notify.deliveries`      | `notify:read`  | `{ notificationId }`                                                            | per-channel attempt + outcome                                                                                                                                                                                        |
| `notify.mutePrefs`       | `notify:read`  | —                                                                               | per-channel mute flags (email/push/sms)                                                                                                                                                                              |
| `notify.setMute`         | `notify:write` | `{ channel, muted }`                                                            | updated mute flags                                                                                                                                                                                                   |
| `notify.categoryPrefs`   | `notify:read`  | —                                                                               | category-by-channel grid; `security` and the inbox are `locked`; `notConnected` names the missing vendor (`vendor.email`, `vendor.push`, `vendor.sms`)                                                               |
| `notify.setCategoryPref` | `notify:write` | `{ category, channel, enabled, clientRequestId }`                               | `{ rows, locked }`; a locked cell stores nothing; each change is kept in `notify.category_pref_history`                                                                                                              |
| `notify.statusFeed`      | public         | `{ days }` (clamped to 90)                                                      | components (`unknown` unless a published notice says otherwise), incidents with update timelines, open maintenance, incident minutes per day; no uptime percentage                                                   |
| `notify.changelog`       | public         | `{ area?, breaking?, limit }`                                                   | published changelog entries, newest first, each with `changelog` (area, breaking flag, endpoints, scopes, `addedOn`, `releaseOn` (null = date not set), before and after example, migration note, retired endpoints) |
| `notify.upcomingChanges` | public         | —                                                                               | `{ upcoming, retired }`: breaking entries not yet in effect, soonest first (an entry with no date is never listed), and every endpoint a published entry retires                                                     |
| `notify.alerts`          | `notify:read`  | —                                                                               | caller's price watches (v22.alerts MVP)                                                                                                                                                                              |
| `notify.createAlert`     | `notify:write` | `{ marketId, direction, targetPrice, condition?, name?, message?, expiresAt? }` | active watch; price is a decimal string; see Price alerts below                                                                                                                                                      |
| `notify.cancelAlert`     | `notify:write` | `{ id }`                                                                        | cancel an active watch                                                                                                                                                                                               |

**Mounted, and proven mounted.** `router.mount.test.ts` proves authorisation
through `createCaller`, which is the right tool for that job and blind to a
different one: it invokes procedures in-process, so it stays green on a service
whose HTTP mount was never registered, sits at the wrong prefix, or was wired to a
context factory that ignores the edge signature.
`mount.reachable.test.ts` assembles the mount the way `index.ts` does — same
plugin, same prefix, same context factory — **listens on a real socket** and asks
over the wire. This service's own history is a complete consumer nobody wired, so
"is it reachable" is asked by a request, not by reading code.

Every procedure is self-only via `principal.userId`. Title/body are i18n keys
(`title_key` / `body_key`); clients render copy from `@intafaced/i18n`
(`notify.*` keys). `notify.deliveries` is user-facing on purpose: if a margin
call's email never went out, the person whose collateral is at risk is the one
who most needs to see it.

**Mute law.** `notify.setMute` silences out-of-app `info` / `action` traffic on
one channel. Prefs live in `notify.channel_mutes` (migration `0003`) so a restart
cannot silently unmute. **Critical** severity never respects mute — a muted
email channel still receives margin calls, and the delivery row says `accepted`
or a real refusal, never `channel.muted`.

### Edge path

Reach this service through **svc-edge** (not direct to port 4015 in production):

| Client path                        | Upstream                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/notify/trpc/<procedure>` | `GET /trpc/<procedure>` on svc-notify (`NOTIFY_URL`, default `http://localhost:4015`) |

Edge strips `/api/notify` and forwards the rest; auth is the edge-signed
principal header (same as every other mounted service).

## Events

**Publishes**

_None._

**Consumes**

| Subject                                   | Consumer (durable)                | Effect                                                                  |
| ----------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `intafaced.trade.fill.settled`            | `notify-fill-settled`             | Inbox row for the fill owner                                            |
| `intafaced.trade.order.updated`           | `notify-order-updated`            | Inbox row on cancelled / rejected / expired only                        |
| `intafaced.trade.position.updated`        | `notify-position-updated`         | **Critical** inbox row + fan-out on liquidation only                    |
| `intafaced.p2p.escrow.locked`             | `notify-p2p-escrow-locked`        | Inbox rows for seller and buyer                                         |
| `intafaced.p2p.escrow.released`           | `notify-p2p-escrow-released`      | Inbox rows when escrow releases to buyer                                |
| `intafaced.p2p.escrow.refunded`           | `notify-p2p-escrow-refunded`      | Inbox rows when escrow returns to seller                                |
| `intafaced.p2p.trade.disputed`            | `notify-p2p-trade-disputed`       | Inbox row for the opener only (no counterparty on payload)              |
| `intafaced.identity.kyc.approved`         | `notify-kyc-approved`             | Inbox row when verification tier is granted                             |
| `intafaced.identity.rank.updated`         | `notify-rank-updated`             | Inbox row when rank changes                                             |
| `intafaced.token.stake.created`           | `notify-stake-created`            | Inbox row when a stake is locked                                        |
| `intafaced.bank.margin_call.created`      | `notify-bank-margin-called`       | **Critical** inbox row + fan-out when a loan is called                  |
| `intafaced.bank.personal_request.created` | `notify-personal-request-created` | Inbox row `pay.request_created` for the person asked to pay             |
| `intafaced.bank.personal_request.settled` | `notify-personal-request-settled` | Inbox row `pay.request_paid` for the person who was paid                |
| `intafaced.agents.action.rejected`        | `notify-agent-action-rejected`    | Inbox row when a guardrail refuses an agent action                      |
| `intafaced.agents.action.completed`       | `notify-agent-action-completed`   | Inbox row on completion / session_close only                            |
| `intafaced.ledger.freeze.updated`         | `notify-ledger-freeze-updated`    | One audience-all inbox notice when the posting freeze is set or cleared |

### Posting-freeze notice (audience `all`)

`ledger.freeze.updated` writes one row to `notify.system_notices` (migration 0016), keyed
`freeze:{changedAt}:{frozen}`, and every user's inbox read merges it in with a per-user
read mark in `notify.system_notice_reads`: `notify.list`, `unreadCount`, `markRead` and
`markAllRead` all include it, so a freeze is one write and not one per account. It is
inbox only (no out-of-app send). Copy keys `notify.ledger.freeze.set` and `.cleared`;
if a key is missing from the catalog the consumer throws `notify.freeze_copy_unset`, writes
nothing and the event is redelivered. The event's reason and actor are never read. It
reports the svc-ledger posting freeze only, not the single-account freeze of svc-identity.

### Recipient health and quarantine

A send that ends `abandoned` (gateway rejected it for good, or the attempt budget was spent) adds one to that
address's failure count in `notify.recipient_health` (migration 0017); an accepted send resets it. A `failed`
attempt that will be retried does not count. When the count reaches `NOTIFY_QUARANTINE_FAILURE_THRESHOLD` the
address is quarantined: non-critical sends are refused `channel.recipient_quarantined` with the stored reason.
Critical messages are still attempted. A blank threshold quarantines nobody, and `notify.operatorRecipients`
returns `thresholdCode: notify.quarantine_threshold_unset`. The row is pinned to the address, so a changed
address starts clean.

- `notify.operatorRecipients` (`admin:read`): `{ state: active | unconfirmed | quarantined, limit }`, addresses masked.
- `notify.operatorReleaseRecipient` (`admin:write`): reason required (`notify.release_reason_required`),
  `reasonId` makes a replay a no-op, unknown recipient `notify.recipient_unknown`, not quarantined
  `notify.recipient_not_quarantined`. Every release appends to the immutable `notify.recipient_release_audit`.
- A provider outage that abandons many sends can quarantine many recipients; release and the threshold are the lever.

### Idempotency and backpressure

Inserts dedupe on `(user_id, source_subject, source_idempotency_key)`. Each send
claims `(notification_id, channel)` atomically, so a redelivered event produces
one row and one message even across replicas. A redelivery still runs fan-out —
that is what recovers a send lost to a crash between the insert and the
transport.

A handler naks **only** when a channel wants another attempt (timeout, 503). A
permanently broken address does not nak: doing so would burn the redelivery
budget for the whole message and eventually park a notification that three other
other channels handled perfectly. After `NOTIFY_MAX_DELIVERY_ATTEMPTS` the row is
`abandoned` rather than left looking like it is still being retried.

**Two things write `abandoned`, and the second one is why the first sentence is
true.** The claim retires a spent row when a later redelivery arrives — but a
message that reaches the attempt ceiling and `max_deliver` together is parked by
JetStream, and no later redelivery arrives. A one-minute sweep
(`reapExhausted`, wired in `index.ts`) retires those rows on the same predicate
the claim uses, **and** retires stuck-`pending` rows whose claim lease has been
dead longer than the bus redelivery window (`STUCK_PENDING_GRACE_MS` =
maxDeliver × ack_wait). That second arm closes the hole where `in_flight` naks
burn `max_deliver` without raising `attempts`, so the attempts-ceiling arm never
fires and the row would otherwise sit `pending` forever. It writes only a failure
— never an attempt, never an acceptance — and never touches a row whose claim
lease is still live. The refusal code names which arm fired:
`channel.attempts_exhausted` when the attempt budget was spent, and
`channel.delivery_stuck` when the bus window elapsed with attempts still left
(so a row with attempts 1 of 3 never pretends the budget was exhausted).

**Register / verify rate limits.** Per `userId`+channel, default 3 registers /
10 verifies per 15 minutes. Named refuse codes, not silent drops. Production
uses a **fixed** window in Postgres (`notify.target_rate_windows`, migration
`0005`) claimed with `SELECT … FOR UPDATE`, so two replicas share one budget
rather than each holding an N× in-process counter. Unit tests may inject the
memory limiter, which is a true sliding window — prod is fixed so the shared
row stays simple; a burst exactly on the reset edge can spend up to ~2× max
across two adjacent windows, not N× per pod.

**Consent footer.** Out-of-app bodies from `renderNotification` append
`notify.channel.footer` (catalog). Verification messages do not (address is still
unconfirmed).

### Channel settings and identity message templates

Both are owner configuration that changes what leaves the platform, so each change
is appended behind a two-person approval (the same identity approval the notice
board uses; a missing approval consumer refuses `notify.approval_unavailable`, the
same person refuses `notify.approval_same_operator`, a spent id
`notify.approval_spent`). `channelSettingProposal` and `templateProposal` return
the hash, target and version the second person's approval has to carry.

- `notify.channelSettings` (`admin:read`) lists email, push and SMS with
  `configured` (read from the environment; no credential is ever returned or
  stored), the owner's switch, the adapter name and `effective`
  (`sending`, `disabled`, `unconfigured`). An unconfigured channel shows
  `notConnected: vendor.<channel>` and its sends stay refused
  `channel.not_configured`. `notify.setChannelSettings` (`admin:write`) switches a
  channel off or on and names its adapter; the dispatcher reads the switched-off
  set once per dispatch and refuses `channel.disabled` for those channels. A switch
  cannot make an unconfigured channel send.
- `notify.templates`, `templateHistory`, `setTemplate`, `previewTemplate`,
  `testSendTemplate`: six keys (recovery, verification, login and registration
  codes, security notices, KYC decisions), plain text with `{{field}}` merge fields.
  Each key declares its fields; an undeclared field, a stray brace, empty copy or a
  code message with no `{{code}}` is refused at save (`notify.template_variable_unknown`,
  `notify.template_syntax_invalid`, `notify.template_copy_empty`,
  `notify.template_variable_required`). `brand` and `antiPhishingCode` are merge
  fields. A save is a new version; nothing is seeded, and a key with no version
  resolves to `notify.template_unset`. A sender calls `MessageTemplates.resolve`
  once at enqueue and renders that row, so a later edit never changes a message in
  flight. A render with a missing field refuses `notify.template_variable_missing`.
  Preview and test-send use TEST values; test-send takes no address, only goes to
  the caller's own confirmed address, and replays by client request id.

### Notification targets and `notify.inboxPolicy`

Every `href` an emitter writes is an internal path the customer app can open or
fall back from; `event-href-targets.test.ts` pins the full list, so a new
emitter with an unknown target fails. P2P events open `/p2p/orders/:tradeId`,
verification `/verification`, rank `/uc/account`, stakes `/token`, futures
positions `/trade/futures`. Bank loans, trade orders, payment requests and agent
sessions keep the detail paths IA-SPEC gives their owning modules. Stored rows
are not rewritten.

`notify.inboxPolicy` (public) serves the owner values for page size, the bell's
unread cap and retention. Blank values come back `null` with their typed code.

### Refusal codes (the wire vocabulary)

Codes, not sentences — clients render copy from `@intafaced/i18n`. Every code a
row can carry is listed in `allRefusalCodes()` (`channels/channel.ts`); a pin
test fails if production writes a string missing from that list.

| Code                            | Means                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `channel.not_configured`        | No gateway credentials for this channel                                                                                         |
| `channel.no_target`             | User has no address on this channel                                                                                             |
| `channel.target_unverified`     | Address on file but never confirmed (critical records this, not silence)                                                        |
| `channel.target_unroutable`     | Address shape unusable (not E.164, bad mailbox, etc.)                                                                           |
| `channel.disabled`              | Operator kill-switch `NOTIFY_OUT_OF_APP_ENABLED=false`                                                                          |
| `channel.muted`                 | User muted non-critical traffic on this channel                                                                                 |
| `channel.attempts_exhausted`    | Attempt budget spent — abandoned after max attempts                                                                             |
| `channel.transport_rejected`    | Permanent gateway 4xx — abandoned with a name, not retried as "failed"                                                          |
| `channel.delivery_stuck`        | Reaper arm 2 — claim lease dead past the bus window; attempts may remain                                                        |
| `channel.register_rate_limited` | Too many address registrations in the window                                                                                    |
| `channel.verify_rate_limited`   | Too many verification guesses in the window                                                                                     |
| `channel.unprobed`              | URL+token set; this process has not POSTed. `/ready` / `notify.channels` door — never a delivery row                            |
| `channel.recipient_quarantined` | Address failed terminally `NOTIFY_QUARANTINE_FAILURE_THRESHOLD` times in a row; non-critical sends wait for an operator release |

The table is the tip wire vocabulary — a pin test fails if it drifts from
`allRefusalCodes()`.

`intafaced.bank.margin_call.created` is keyed `<loanId>:<sequence>`, not
`<loanId>` — a loan can be called, cured and called again, and the second call is
a different fact.

### `trade.order.updated` — terminal statuses only

That subject is published on every order row change (pending / open / filled /
cancelled / rejected / expired). Fills already have `fill.settled`. Pending and
open are things the trader just did, and the private WS already fans the live
row. The inbox consumer writes only on **cancelled**, **rejected**, and
**expired** — the cases that can complete while the app is closed.

Which other statuses deserve a message is product law. It lives in
`DEFAULT_ORDER_TERMINAL_NOTIFY_POLICY` (`src/events.ts`). Severity is `info`
(mute may apply). The key is `<orderId>:<status>`; `ts` is not part of it.

### `trade.position.updated` — one transition of four

That subject is published on **every** futures position transition, and again
when a moving mark price liquidates one. Fanning all of them out would put an
inbox row, and for anyone with a confirmed address an email, behind every open
and every close a trader makes. An inbox nobody reads is the same outage as an
inbox nothing writes to, so the consumer notifies on `liquidated` **only**:
opening, closing and closed are things the trader just did, and a liquidation is
the one that happened to them while they were not looking.

Which other transitions deserve a message is product law and has not been
decided. It lives in `DEFAULT_POSITION_NOTIFY_POLICY` (`src/events.ts`) as a
policy object with the conservative default, rather than as an `if` — widening
it is a change to `statuses` plus two i18n keys per new state. It is
deliberately **not** an environment variable: which notifications exist is a
product fact that should read the same in every deployment.

The row is `critical` for the same reason the margin call is: refusals get
recorded on every out-of-app channel even when the trader registered none, and a
channel mute does not silence it. The key is `<positionId>:<status>`, so a
widened policy cannot collapse two transitions of one position into one row —
and `ts` is deliberately not part of it, so a producer re-publishing with a
fresh timestamp cannot turn a duplicate into a second liquidation notice.

A `critical` notification records a refusal on **every** out-of-app channel even
when the user registered none, so "we had no way to reach you" is a row written
at the moment it mattered rather than an inference from an empty table later.

### Consumers whose stream does not exist yet

A durable consumer cannot be created against a stream no service has published
to. When that happens the consumer is reported as **pending** on `GET /ready` and
logged at info (declared wiring socket) or error (undeclared defect), rather than
failing the whole boot or being skipped in silence. Nothing is lost: JetStream
retains 90 days and the consumer replays from the start of the stream on a later
boot.

`intafaced.bank.margin_call.created` used to sit in that state; svc-bank now
owns the bank stream and publishes margin calls. The consumer attaches when the
stream is present — pending is no longer the steady state for that subject.

## Price alerts (v22.alerts MVP)

Watchlists live here: a user sets `marketId` + `above|below` + decimal-string
`targetPrice`. Evaluation rides the same fan-out as every other notification
(`NotifyService.create` → inbox + channels). There is no second delivery path.

| Procedure            | Scope          | Effect                                            |
| -------------------- | -------------- | ------------------------------------------------- |
| `notify.alerts`      | `notify:read`  | the caller's watches **+ whether one can fire**   |
| `notify.createAlert` | `notify:write` | create a watch, returned with the same disclosure |
| `notify.cancelAlert` | `notify:write` | cancel an active watch                            |

**Evaluation is a mounted sweep, and it used to be nothing at all.**
`evaluateMarket` shipped complete and tested with **no caller**: this file and
`router.ts` both called it "an internal job path" and there was no job. A user
created a watch, got `status: 'active'`, and nothing ever looked at the row again
— D-S-13 Class B, the same shape as `bankMarginCalled` parking with a finished
consumer. `AlertService.evaluateDueAlerts` now fans in from `activeMarkets()` (so
a watch on a market nobody enumerated is still evaluated) and `index.ts` drives it
every `ALERT_SWEEP_INTERVAL_MS`, clearing it on shutdown. The last pass is on
`/ready`; a null `lastAt` means the driver never ran.

**Dark mark refuse.** Evaluation is pure (`evaluatePriceAlert`) against an
injected mark port. `acceptAlertMark` is the accepted-mark gate: a `kind: 'dark'`
source cannot fire even if `quote()` invents `{ kind: 'ok' }`, and an absent
quote is refused rather than treated as zero. A live `{ kind: 'ok' }` whose
`at` is older than 300s (same ticker window bank uses for loan marks) or dated
more than 30s in the future is `stale` / `refused` — a one-shot must not fire
on a memory. When the accepted mark is unavailable (dark / stale / refused),
the outcome is `alert.price_unavailable` and **nothing is written to the inbox**.

**Out-of-app required.** If this deployment listed a channel in
`NOTIFY_REQUIRED_CHANNELS` and that channel cannot deliver, a crossing watch
refuses `channel.not_configured` / `channel.disabled` by name — it does not
silently drop the device leg and mark the watch fired. Inbox-only (nothing
required) remains the honest fallback; sockets stay open (tracker `ready`).

**Live mark when `TRADE_URL` is set.** Production injects
`createTradeHttpMarkSource` against svc-trade's public REST — the same
`GET /api/v1/markets` + `GET /api/v1/ticker/:symbol` surface svc-bank already
uses for loan marks (mid when two-sided, else last; decimal strings only).
Unset / blank `TRADE_URL` keeps the dark port: CRUD still works; fire does not
lie. `kind: 'live'` is claimed only by that factory, never hardcoded in the
entrypoint to look finished.

`MarkSource.kind` (`dark` | `live`) is **required**, because an optional field
with a default is how a dark source silently reads as a live one. It describes
wiring, not weather: a `live` feed may still answer `unavailable` on any given
quote.

**The disclosure rides with the data.** Both read and create return
`evaluation: { markSource, canFire, code }`, so a client cannot render somebody's
watchlist — or confirm a watch they just created — without also receiving the fact
that nothing on it can currently cross. `canFire: true` says the wiring is not
missing and **nothing more**: delivery is best-effort on every channel (§8) and
there is no SLA here.

**One-shot.** Crossing inserts one notification keyed `<alertId>:<markPrice>`,
then marks the row `fired`. Order is deliberate: mark-before-notify used to burn
a watch under fan-out kill or a crash mid-create (status `fired`, empty inbox,
no retry). Notify first; only retire the watch when create produced or recovered
a row. A redelivery reuses the same key and cannot double-send.

**Conditions, expiry, name and message (C-alerts-scan-01).** `createAlert` also takes:

- `condition`: `greater_than` / `less_than` are levels (fire whenever the mark is at or past the target; what `direction` always
  meant). `crossing_up`, `crossing_down` and `crossing` fire only when the sweep sees the mark on the other side from last time
  (`last_side`, never on the wire; at the target counts as at-or-above). A watch created while the mark is already past its
  target waits for a real crossing; one with no earlier observation records a side and fires nothing. The side is remembered only
  on a hold, so a crossing the fan-out kill swallowed is tried again next pass. A `direction` that contradicts a named condition
  is a `BAD_REQUEST`.
- `expiresAt` (ISO time; omitted is open-ended). The sweep, the market pass and the evaluate door all retire a due watch to
  `expired` first, so an expired watch never fires and cannot be cancelled back. Owner setting `NOTIFY_ALERT_MAX_EXPIRY_DAYS`
  is the furthest an expiry may be; blank refuses `notify.alert_expiry_max_unset`. A past time is `alert.expiry_in_past`, a
  too-far one `alert.expiry_too_far`.
- `name`, `message`: the person's own words, at most `NOTIFY_ALERT_TEXT_MAX_LENGTH` characters; blank refuses
  `notify.alert_text_limit_unset`, too long is `alert.text_too_long`. A message may use `{market}`, `{price}` (the mark that
  fired it), `{condition}` and `{time}` (UTC); any other `{word}` is `alert.message_placeholder_unknown`. A fired alert with a name
  or message shows those instead of the stock copy.
- `extras` (C-alerts-scan-01b): further level conditions (`greater_than` / `less_than`, a positive decimal price) on the same
  market. The alert fires only when its main condition and every added one hold on the same mark, so a range is "at or above
  100 and at or below 120". A crossing main condition still needs a real crossing, and the added levels must hold when it
  happens. The most conditions one alert may hold, the main one included, is `NOTIFY_ALERT_MAX_CONDITIONS`; blank refuses
  `notify.alert_conditions_limit_unset` for an alert that adds any, too many is `alert.too_many_conditions`, a bad added condition
  `alert.extra_condition_invalid`. An added crossing condition is not offered: it has no remembered side. Migration 0019.
- Alert manager (C-alerts-scan-02): `notify.updateAlert` changes an alert that is active or stopped (price, condition, name,
  message, expiry, added conditions; `null` clears a name, message or expiry). It is checked as a create is, so a blank owner
  setting still refuses, and an alert that has triggered, expired or been cancelled is `alert.not_editable`. An edit forgets the
  side a crossing was last seen on. `notify.setAlertActive` pauses an active alert (`stopped`: never fires, keeps its place) or
  resumes it; repeating either is harmless, and a stopped alert past its expiry becomes `expired`. `notify.deleteAlert` removes an
  alert in any state, once, for its owner only. `updatedAt` is when the person last changed it. Migration 0020.
- Trigger log (C-alerts-scan-02): each fire writes one row (alert, market, the condition and level it asked for, the mark that
  fired it, when, the inbox item) after the inbox has it and before the alert is marked fired, keyed by the alert so a retry
  after a crash writes it once. `notify.alertTriggers` reads the person's own rows, newest first, for all alerts or one. How long
  rows are kept is `NOTIFY_ALERT_TRIGGER_LOG_DAYS`; blank writes no log, the read refuses `notify.alert_trigger_log_retention_unset`,
  and alerts still fire. The sweep prunes rows past the retention. Migration 0021.
- Quota (C-alerts-scan-03a): `NOTIFY_ALERT_MAX_ACTIVE_PRICE` is the most price alerts one person may hold open, active or
  paused. No default: blank refuses every price alert create `notify.alert_quota_unset`; at the cap a create is refused
  `alert.quota_reached` (precondition, nothing stored). Triggered, expired, cancelled and deleted alerts do not use a place,
  and an alert past its stop time is expired before the count. The count and the write happen under one per-person lock, so
  two creates racing for the last place cannot both pass. `notify.alertQuota` reads `{used, max}` (`max: null` while blank).
  Other alert kinds have no quota setting and are not counted. Burst auto-stop (03b) and watchlist expansion (03c) are separate.
- Not built here, and refused rather than faked: trigger frequencies other than once (C-alerts-scan-01c) and technical
  (indicator) alerts (C-alerts-scan-01d).

Out of scope for this residual (tracker + §31): funding / liquidation-proximity
alerts, whale-flow intelligence tiers, mobile watchlist sync, owner gateway
credentials (Class X — same as every out-of-app channel).

## Ledger

This service holds no balances and posts no ledger transactions.

## Kill-switches

| Switch                      | Effect                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `NOTIFY_FANOUT_ENABLED`     | Off: consumers ack, nothing is written, nothing is sent anywhere.                                              |
| `NOTIFY_OUT_OF_APP_ENABLED` | Off: inbox still fills; every out-of-app channel refuses `channel.disabled`.                                   |
| `NOTIFY_INCIDENT_SILENCE`   | On: `venueIncident.allFine` stays false until `NOTIFY_INCIDENT_ALL_CLEAR`. Matching resume is not auto-unmute. |
| `NOTIFY_INCIDENT_ALL_CLEAR` | Explicit all-clear. Halt / missing matching source still refuse `allFine`.                                     |
| flag `notify.fanout`        | Module kill-switch in `packages/config`.                                                                       |

The second is the one to reach for during an incident — it silences customers'
phones without also blinding them. It may **not** be combined with a non-empty
`NOTIFY_REQUIRED_CHANNELS`: a deployment that requires a channel and switches all
sending off is a contradiction, and it is the shape a bad rollback takes. The env
schema refuses it.

`NOTIFY_FANOUT_ENABLED=false` is the same contradiction when
`NOTIFY_REQUIRED_CHANNELS` names a channel: consumers ack, insert no inbox rows,
and send nothing, even with out-of-app on and gateway credentials set. The env
schema refuses that boot. `none` may still turn fan-out off.

`NOTIFY_OUT_OF_APP_ENABLED=false` also counts as incident-silence for the venue
claim: health/ready must not read as allFine. Flipping sending back on is not an
all-clear unless `NOTIFY_INCIDENT_ALL_CLEAR` is set and matching `GET /markets`
is actually open.

## Environment

| Variable                                | Default | Notes                                                                                                                                   |
| --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTIFY_{EMAIL,PUSH,SMS}_GATEWAY_URL`   | —       | Unset ⇒ the channel refuses `channel.not_configured`.                                                                                   |
| `NOTIFY_{EMAIL,PUSH,SMS}_GATEWAY_TOKEN` | —       | ≥16 chars. A URL without a token refuses to boot: it is an open relay.                                                                  |
| `NOTIFY_REQUIRED_CHANNELS`              | —       | Subset of `email,push,sms`, or `none`. **Mandatory in staging/prod.**                                                                   |
| `NOTIFY_GATEWAY_TIMEOUT_MS`             | `5000`  | Budget for one gateway call. Max **25000** (claim-lease ceiling) so a lease always outlasts one attempt.                                |
| `NOTIFY_MAX_DELIVERY_ATTEMPTS`          | —       | 1–5, at or below the bus `maxDeliver`. Blank refuses `notify.max_delivery_attempts_unset` — never invent 3. Owner may set 3 explicitly. |
| `NOTIFY_SMS_MAX_CHARS`                  | `480`   | Three GSM segments.                                                                                                                     |
| `NOTIFY_VERIFY_TTL_MINUTES`             | —       | 1–120. Blank refuses `notify.verify_ttl_unset` — never invent 15. Owner may set 15 explicitly.                                          |
| `NOTIFY_VERIFY_CODE_PEPPER`             | —       | Required. Blank refuses `notify.verify_code_pepper_unset` — no default. HMAC key for confirmation codes.                                |
| `TRADE_URL`                             | —       | Unset ⇒ alert marks stay dark. Set ⇒ public ticker mark source (live wiring).                                                           |
| `MATCHING_URL`                          | —       | Unset ⇒ venue halt unwired (not allFine, not invented halt). Set ⇒ consume GET /markets. Never POST /halt-all.                          |
| `NOTIFY_INCIDENT_SILENCE`               | `false` | Latch: matching-open is not allFine until `NOTIFY_INCIDENT_ALL_CLEAR`.                                                                  |
| `NOTIFY_INCIDENT_ALL_CLEAR`             | `false` | Explicit recovered. Halt / unavailable matching still refuse allFine.                                                                   |
| `NOTIFY_INBOX_PAGE_SIZE`                | —       | 1–100. Served by `notify.inboxPolicy`; blank reports `notify.list_limit_unset` — never invent 20.                                       |
| `NOTIFY_INBOX_UNREAD_CAP`               | —       | Bell "<cap>+" ceiling. Blank reports `notify.unread_cap_unset` — never invent 99; the bell then shows the exact count.                  |
| `NOTIFY_INBOX_RETENTION_DAYS`           | —       | Blank keeps every row, and `inboxPolicy` says so (`retention: keeps_every_row`).                                                        |
| `NOTIFY_QUARANTINE_FAILURE_THRESHOLD`   | —       | Consecutive terminal send failures that quarantine an address. Blank quarantines nobody (`notify.quarantine_threshold_unset`).          |

An empty string is treated as absent, because that is what `docker compose`
interpolates an unset variable to — otherwise an unwired gateway would fail
`z.string().url()` and take the service down instead of leaving the channel
honestly unconfigured.

## §13 sockets

| Socket    | State                                                                                                                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email     | Adapter shipped and tested against a real HTTP server. **Waiting on credentials the owner must obtain.** Unconfigured, it refuses every message.                                                                                                                                                                                               |
| Push      | Same. Device tokens register and confirm per user; no push credentials configured.                                                                                                                                                                                                                                                             |
| SMS       | Same. Addresses are E.164, text is composed and capped; no SMS credentials configured.                                                                                                                                                                                                                                                         |
| Mark feed | Sweep **mounted and running**. With `TRADE_URL` set, marks read trade's public ticker (live wiring; empty book still refuses). Without it the port is `dark` and every evaluation refuses `alert.price_unavailable` with disclosure on both alert procedures. Class **C** when dark — the gap is named where a user could otherwise be misled. |

Email/push/SMS each need a URL and a token before they leave the platform; until
then the in-app inbox carries every notification and the record says why nothing
else did. The owner's list of what to obtain and where to put it:
[`docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`](../../docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md).

## Independent mailbox relay

`node services/svc-notify/dist/gateway/index.js` starts the private relay independently of the platform bus, identity, guest database and notification workers. It adapts the existing email gateway envelope to a configured HTTPS mailbox endpoint accepting `{to:[address], displayName, subject, text}` and an empty HTTP204 response. HTTP204 confirms endpoint acceptance; it does not prove recipient arrival or human reading. No provider SDK is installed.

Provision a separate notify-owned receipt database/schema and role before starting. Set `NOTIFY_RELAY_DATABASE_URL`, `NOTIFY_RELAY_TOKEN` (32–4096 printable characters), `NOTIFY_RELAY_SEND_URL` (the full HTTPS send endpoint), `NOTIFY_RELAY_SEND_TOKEN` (a distinct private upstream credential), `NOTIFY_RELAY_TIMEOUT_MS` (100–10000), and `NOTIFY_RELAY_PORT`. `NOTIFY_RELAY_HOST` defaults to `127.0.0.1`; keep the listener private behind verified TLS ingress. Set the main service email gateway URL to that ingress `/send` and its token to the relay bearer; allow its transport budget to outlast the bounded relay attempt. `/ready` is authenticated and checks receipt storage only, returning upstream `unprobed`.

The entrypoint applies only `drizzle/gateway/0000_mailbox_relay.sql`. Normal guest up/down migrations never enumerate this subdirectory. Never include this database in a prospect or guest rollback. An accidentally identical configured guest/relay database URL refuses startup, but URL spelling cannot establish physical independence, restricted access or backup protection. Verify actual host/restore placement before admitting live traffic. Credentials remain in private runtime secrets, never URLs, source, browser assets or logs.

Guest transport keys derive from the immutable business key rather than the generated notification UUID. The relay commits a hashed key and delivery fingerprint before one upstream attempt; no recipient, body, notification ID, credential or response body is retained. Concurrent/crashed/unknown attempts never authorize another send. Exact accepted repeats return the original opaque receipt, including after an old guest-database restore changes its notification UUID. Changed delivery under that key conflicts. The relay follows no redirects. Known upstream401/403/422 refusals are permanent; other statuses/timeouts or failed/late receipt writes remain acceptance-unknown. Keep those distinctions in the CRM.

Actual SQL/HTTP fixtures and pg_dump/restore demonstrate this ordering and stable-key recovery. The separately retained receipt database must survive any guest restoration. These checks do not establish deployed TLS, upstream credential validity, recipient arrival, backup rotation or human mailbox monitoring. An opaque receipt ledger can prevent repeated attempts while retaining minimal restoration authority; it cannot establish whether an unknown upstream response delivered a message.

## Port

`4015` · schema `notify` · role `svc_notify`

## Service keys: guest ingress door

The guest notification procedures name the producer from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the pairwise `NOTIFY_OPS_SERVICE_SECRET`, `keypair` the key only. Unset, the pairwise secret works exactly as before. A key-signed call that fails is refused and never retried against the secret. The procedures still run only for a call named svc-ops. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
