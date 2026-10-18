# TRK-ops.notifications — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.notifications`  
**Title:** Event-driven fan-out: in-app, push, email, SMS  
**Module / phase:** `notify` · phase 5 · plane F  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `infra.events` (done) · **requires:** `services/svc-notify`  
**Sibling sockets (not this mountain’s min DoD):** `socket.notify-email` · `socket.notify-push` · `socket.notify-sms`  
**Tip freeze:** `origin/main` @ `81771578` (re-derive before implement)  
**Pack type:** research only — **no implementation**, no `features.mjs` edit, no LIVE-LANES claim required to keep this doc.

---

## 1 · What “done” means (plain language)

1. Domain events on the bus become **durable inbox rows** for the right user(s).
2. Every out-of-app channel (email / push / SMS) only sends to **confirmed** addresses owned by that user.
3. Delivery bookkeeping never lies: **attempt** and **accepted-for-delivery** stay separate forever. A gateway 2xx is **custody**, not “user received / read.”
4. Missing credentials, disabled channels, and unroutable targets produce **named refusals on delivery rows** — never silent success, never dropped without a record.
5. In-app is always the honest fallback when out-of-app cannot send.
6. Staging/prod declare which channels are **required** (`NOTIFY_REQUIRED_CHANNELS` or explicit `none`); boot fails if a required channel is unconfigured.
7. No partner / provider brand in user-facing copy or service code (§0.7) — gateways are URL + bearer only.

**Not in min DoD of this mountain:** price alerts, watchlists, digests, whale pings (doctrine “alerts & watchlists” = Phase 2/5 **extension** of svc-notify). Those depend on this fan-out existing, not on finishing them first.

---

## 2 · Current code state (tip)

### 2.1 Service spine

| Area          | Path / fact                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Service       | `services/svc-notify/` · port **4015** · schema `notify` · role `svc_notify`                                                |
| Migrations    | `0000_notify_init` · `0001_notify_channels` · `0002_notify_delivery_accepted` (`accepted_at`, not `delivered_at`)           |
| Core          | `notify-service.ts`, `dispatch.ts`, `store.ts`, `channel-store.ts`                                                          |
| Channels      | `src/channels/` — `NotificationChannel` interface + email / push / SMS + `gateway.ts` wire tests against a real HTTP server |
| Bus           | `events.ts` → durable consumers (see below)                                                                                 |
| Edge          | `GET /api/notify/trpc/<procedure>` → svc-notify `/trpc/*` (`NOTIFY_URL`)                                                    |
| Copy          | Out-of-app render via `@intafaced/i18n` (`render.ts`); inbox title/body are **keys**, client renders                        |
| Owner runbook | `docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`                                                                                     |

### 2.2 API (self-only via `principal.userId`)

| Procedure                                                             | Scope                   | Role                                                    |
| --------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `notify.list` / `unreadCount` / `markRead` / `markAllRead`            | `notify:read` / `write` | In-app inbox                                            |
| `notify.channels`                                                     | `notify:read`           | Availability + missing env names                        |
| `notify.targets` / `registerTarget` / `verifyTarget` / `removeTarget` | read/write              | Confirmed channel addresses                             |
| `notify.deliveries`                                                   | `notify:read`           | Per-channel attempt + outcome (user-visible on purpose) |
| `health`                                                              | public                  | `{ ok, service, fanoutEnabled }`                        |

### 2.3 Bus consumers (durable names)

| Event key                        | Subject (catalog)                    | Effect                                                                                                      |
| -------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `fillSettled`                    | `intafaced.trade.fill.settled`       | Inbox for fill owner                                                                                        |
| `p2pEscrowLocked`                | `intafaced.p2p.escrow.locked`        | Seller + buyer                                                                                              |
| `p2pEscrowReleased` / `Refunded` | p2p escrow subjects                  | Party rows                                                                                                  |
| `p2pTradeDisputed`               | disputed                             | **Opener only** (payload has no counterparty)                                                               |
| `kycApproved`                    | identity KYC                         | Tier granted                                                                                                |
| `rankUpdated`                    | identity rank                        | Rank change                                                                                                 |
| `stakeCreated`                   | token stake                          | Stake locked                                                                                                |
| `bankMarginCalled`               | `intafaced.bank.margin_call.created` | **Critical** + fan-out; stream may still be **pending** until svc-bank publishes (`ownedStreams: ['bank']`) |

**Deliberately not fanned:** some P2P resolve subjects name moderator/system only — documented in `packages/events` catalog + notify wiring comments.

### 2.4 Idempotency & honesty rules (already enforced in code)

- Inbox insert dedupe: `(user_id, source_subject, source_idempotency_key)`.
- Delivery claim: `(notification_id, channel)` atomic; max attempts from `NOTIFY_MAX_DELIVERY_ATTEMPTS` (1–5, ≤ bus maxDeliver).
- Nak **only** on retryable transport failures; permanent address failures do **not** burn redelivery budget for sibling channels.
- Critical severity: refusal rows on every out-of-app channel even if user registered none (“no way to reach you” is a written fact).
- Kill-switches: `NOTIFY_FANOUT_ENABLED`, `NOTIFY_OUT_OF_APP_ENABLED`, flag `notify.fanout` — required channels + out-of-app-off is a **boot contradiction**.

### 2.5 Honest residual vs tracker

| Claim                                 | Tip truth                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-app inbox                          | **Shipped** and tested                                                                                                                                               |
| Multi-channel adapter + delivery rows | **Shipped**; gateway contract stable                                                                                                                                 |
| Real email/push/SMS to humans         | **Blocked on Class X secrets** — unconfigured channels refuse `channel.not_configured`                                                                               |
| `ops.notifications` tracker `done`    | **Must not flip** while all out-of-app channels refuse in every real deploy                                                                                          |
| Tracker note age                      | Note is largely **accurate** (multi-channel exists; credentials missing). Prefer this pack + service README over older scoreboard lines that only say “inbox ready.” |

---

## 3 · Doctrine constraints

| Law                   | Implication                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| §0.4 single interface | Channels share one adapter shape; no one-off “just email” path                                                                                |
| §0.6 / §0.7           | No balances in notify; no vendor names in user copy or service branding                                                                       |
| §2 service boundaries | **Must not** read `identity.users.email` — login email ≠ consent to message; own `notify.channel_targets`                                     |
| §9 i18n               | Out-of-app copy rendered server-side from keys; clients render inbox from same catalog                                                        |
| Money / margin        | `accepted` ≠ “borrower knows.” svc-bank `notified_at` / grace clocks must not silently treat gateway 2xx as human receipt without product law |
| Agent protocol        | One service per PR; no money invent; gateway provider choice is **owner**, not agent                                                          |
| Class X               | ESP / APNS-FCM style / SMS aggregator accounts + contracts + jurisdiction                                                                     |

---

## 4 · DoD sketch (checkable)

- [ ] Staging deploy with `NOTIFY_REQUIRED_CHANNELS` set (or explicit `none`) boots only when consistent.
- [ ] One real gateway (or owner forwarder) for **at least one** out-of-app channel: event → inbox row → delivery row with `attempted_at` + `accepted_at` **or** honest refusal code.
- [ ] Unconfigured channel still produces refusal rows; `notify.channels` / `/ready` name missing vars.
- [ ] Confirm target flow: register → code via same channel → verified → send; unroutable refused without outbound call.
- [ ] Critical path (margin when bank publishes) still records “no channel” refusals if user has no targets.
- [ ] No tracker `done` until product/risk accepts “in-app only” **or** at least one required out-of-app channel is live in the deploy that matters.
- [ ] Alerts/watchlists remain **separate** tracker/extension work.

---

## 5 · Open questions (owner / product)

1. **Which channels are required** for production margin and KYC? (`email` alone vs `email,sms` vs `none` + in-app only) — risk call.
2. **Provider vs forwarder:** point gateways at vendor HTTP APIs or run a small forwarder? (URL+token design supports both; contract language is owner.)
3. **User-facing “delivered” language:** forbidden as stronger than `accepted` unless receipts are designed (currently not modelled).
4. **bankMarginCalled stream:** when does human-claimed bank work attach bus publish? Notify consumer is ready; publish is not this mountain.
5. **Preference / mute / digest cadence:** not built; product law if users can silence critical.
6. **Push device tokens lifecycle:** register/confirm exists; mobile app ownership of token refresh is outside this pack.

---

## 6 · Estimated size (if free to implement later)

| Slice                                                          | Size       | Notes                                                      |
| -------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| Owner credentials + `NOTIFY_REQUIRED_CHANNELS` in one non-prod | **XS** ops | No code; Class X                                           |
| Prove one channel end-to-end in staging + delivery-row proof   | **S**      | Tests against real gateway or recorded forwarder           |
| Extra bus consumers (new catalog events only)                  | **S each** | Catalog/events PR first if new subjects                    |
| Alerts / watchlists product                                    | **L+**     | Separate program; depends on this fan-out                  |
| Delivery receipts / webhooks                                   | **M**      | Schema + product wording; do not rename `accepted` lightly |

**First implement PR (when free):** after secrets exist — one channel live in non-prod + proof test; **without secrets** only Class N docs/runbook or additional **non-delivery** consumers. Do not fake accepted rows.

**Ownership note:** Denon parallel board once listed ops.notifications under Denon product plane; Nitro agents may ship pure residual + docs under Class matrix when free. No Shehzad M1–M7 touch. Gateway secrets remain Nitro human.

---

## 7 · Related docs (read before coding)

- `services/svc-notify/README.md`
- `docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`
- `packages/events/src/catalog.ts` (delivery semantics + orphans)
- `packages/i18n` (notify.* keys; catalog completeness tests in notify)
- Tracker siblings: `socket.notify-*` (§13 credential sockets)

---

## 8 · Explicit non-goals for this pack

- No gateway credential selection by agents.
- No inventing money notifications for unbuilt products.
- No editing `tooling/tracker/features.mjs` from research.
- No dual-edit of open Denon PRs that touch edge/bank money paths for “just notify.”
