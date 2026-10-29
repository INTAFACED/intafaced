# ADR: who may call whom, for the service-access calls left open on 2026-10-22

**Status:** accepted 2026-10-22. Decided by an agent on security and least-privilege grounds under the project's rule that technical calls do not wait on the owner. The svc-dex sign-in call (section 3.2) was put to the owner, who chose the recommended option on 2026-10-22.
**Date:** 2026-10-22
**Area:** service-to-service identity (`packages/contracts/src/service-keys.ts`), the ledger post allowlist and door lists (`services/svc-ledger/src/caller-allowlist.ts`, `door-callers.ts`), the Edge route table and admin routes (`services/svc-edge/src/routes.ts`, `admin-api.ts`), and the cross-service reads named below.
**Answers:** the "HELD-S2S" items in the 2026-10-22 slice packs: S2S roles for svc-protocol and svc-dex, a ledger grant for svc-academy, svc-p2p's reference price, svc-support's guest email, the svc-bank holdings join, svc-ops staff holds, a `feeCharge` grant for svc-bank, an Edge route for `ledger.transactionGet` (#5786) and an Edge row for `GET /api/v1/announcements`; also the related holds on RC-bank-03 (card tier read), RC-merchant-03 Lane A totals and BK-cops-03 (account freeze read).
**Builds on:** the S2S v3 design in `service-keys.ts` (one Ed25519 key per service; the caller is the key's owner) and `serviceProcedureFor` (`packages/contracts/src/trpc.ts:430`); the ledger caller binding (`caller-allowlist.ts`, `caller-binding.test.ts`); the Edge rule that the money plane is never proxied (`routes.ts:11-18`).

## Context

Checked on `origin/main` 45d76a4 (2026-10-22).

- **Today services speak to each other with one shared secret.** The local stack leaves `S2S_AUTH_MODE` unset (`tooling/scripts/local-test-stack.mjs:706`), so receivers accept `INTERNAL_SERVICE_SECRET`, and under that secret the caller's name is a claim, not a proof (`trpc.ts:425-428`). A service that holds the secret can call `ledger.post` as any service. That is why svc-dex withholds it (`services/svc-dex/src/env.ts:8-18`).
- **The v3 keys are built and not switched on.** `SERVICE_NAMES` lists 21 services and leaves out blueprint, dex, indexer and protocol (`service-keys.ts:14`).
- **A key is wider than it looks.** Any service in `SERVICE_NAMES` passes every blanket `serviceProcedure` (`trpc.ts:419-422`) and every raw internal route that only checks that some service verified, for example identity's `rank.awardXp` (`services/svc-identity/src/router.ts:1955`), `actionApproval.consume` and `/internal/account/:userId` (`services/svc-identity/src/index.ts:783`). Only `serviceProcedureFor(CALLERS)` and named door lists such as `LEDGER_DOOR_CALLERS` narrow it.
- **A ledger post grant is wider than it looks too.** `door-callers.ts:14-17` makes every poster a reader of `balance`, `balances`, `txByKey`, `txById`, `history` and `historyPage`, for any owner.
- **svc-protocol already holds the shared secret** for one call, the identity approval behind the founding-badge stuck-mint clear (`services/svc-protocol/src/env.ts:167`, `nft/founding-badge-approval.ts`). In shared-secret mode that secret could also sign a ledger post under another service's name.
- **The ledger allowlist has to match production call sites exactly.** `caller-binding.test.ts` fails on a grant whose cited file does not call the recipe (stray) and on a production `recipes.<name>(` call with no grant (missing).
- **A service can already act for the signed-in user without a role of its own.** It passes the Edge-signed principal on byte for byte (`forwardedPrincipalHeaders`, `packages/contracts/src/edge.ts:513`; used in `services/svc-pay/src/founder-authority.ts`), and the receiver checks that user's own scopes as if the browser had called it.
- **Public market data is read without credentials.** svc-bank prices portfolios from svc-trade's public `/api/v1/tickers` and `/api/v1/markets` (`services/svc-bank/src/portfolio/portfolio-service.ts:143-193`).

## The rules every call below follows

Use the first rule that fits. Each one is narrower than the rules after it.

1. **Public data: read it publicly.** No credential, no new trust.
2. **The signed-in user's own data: forward their Edge-signed principal.** The receiver checks that user's scope, so the caller can do nothing for a user who is not behind the request, and nothing at all for a background job. A forwarded principal is not bound to one audience and can be presented to any service that trusts the Edge key until it expires (`edge.ts:296-314`). That is an existing property: every service behind Edge already receives the same principal on every request, so forwarding adds no new holder of it. Do not log or store it.
3. **An existing event on an existing publisher and consumer pair**, when the payload carries no credential. A link token or other credential never goes on the event bus, where streams keep it.
4. **A named service call:** one procedure on the receiver, wrapped in `serviceProcedureFor(CALLERS)`, with the `CALLERS` list exported from `packages/contracts` beside the procedure's schemas and checked against `SERVICE_NAMES` by a test (the pattern of `support-trade-summary.ts:27` and `bank-approver-eligibility.ts:23`). Never a new blanket `serviceProcedure`, never a new raw route that accepts any verified service.
5. **A ledger post grant:** one recipe, one module, one citing file, in `caller-allowlist.ts`. A new poster does not become a ledger reader: the grant PR keeps it off the read doors in `door-callers.ts`, except `txByKey`, which answers identifying fields only (`s2s-http.ts:260-279`) and is what a saga needs to resolve its own unknown outcome. A test proves the service is refused on `balance`, `balances`, `history` and `historyPage`.

Standing rules that go with these:

- **The Protocol Plane gets no S2S identity and no shared secret.** dex, protocol, indexer and blueprint stay out of `SERVICE_NAMES`, never gain `INTERNAL_SERVICE_SECRET`, and never appear in the ledger allowlist or door lists (`pnpm scan:custody`). svc-protocol keeps the secret it already holds only until the keypair switch at launch (section 3.1). If a Protocol Plane service ever does need a key, the precondition is that blanket doors refuse it first: `verifyServiceRequest` (`service-auth-http.ts:69`) reports such a caller only to doors that name it, and `serviceProcedure` refuses it. That change lands before any keyring carries the key.
- **A ledger grant lands in the same PR as its first caller.** AGENTS.md asks for one service per PR and for a green `main`, and here they conflict: the caller-binding test turns `main` red if the grant and its call site merge apart, in either order. Green `main` and the test win. That PR is the caller service's slice plus its one allowlist entry, its `door-callers.ts` exclusion and a grant test like `mining-pool-grant.test.ts`, and nothing else in svc-ledger. It is money code, so it gets `/security-review` and the independent review. The slice's recipe PR in `packages/ledger-client` goes first.

## Decisions

### 3.1 svc-protocol: no S2S key; user reads forward the principal

None of the four calls the packs hold behind "a role for svc-protocol" needs one:

| Call                                                                             | Shape                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RC-pay-02 `identity.walletPay.ownerOf`                                           | Binding a handle is done by the signed-in owner: forward the principal (rule 2) to a user-scoped identity read. The background consumers in RC-pay-02 (handle changed, consent withdrawn) delete rows by key and call no one.                                                                          |
| RC-bank-03 card tier                                                             | The signed-in user's own `cardTier`: forward the principal (rule 2).                                                                                                                                                                                                                                   |
| RC-merchant-03 Lane A totals, svc-pay to svc-protocol                            | The signed-in merchant's own totals: svc-pay forwards the principal (rule 2) to svc-protocol's user-scoped read. A token without the scope refuses `pay.lane_a_unavailable`, never a partial total.                                                                                                    |
| Badge stuck-mint dual control, svc-protocol to identity `actionApproval.consume` | Stays on the shared secret it uses today, and fails closed (`badge.stuck_approval_unwired`) when the platform runs keypair-only. Replacing it is on the launch-hardening list: either the narrowed key described in the standing rule above, or the approval consumed by a non-Protocol-Plane service. |

So the comment at `service-keys.ts:14` stays true, and no code change is needed for svc-protocol now.

### 3.2 svc-dex: no S2S key; wallet order sessions live in svc-identity (owner's choice, 2026-10-22)

The D-limit-dca-01 pack has svc-dex issue and check wallet sign-in nonces by calling svc-identity. That needs svc-dex to authenticate to identity, which needs either the shared secret (a Protocol Plane bug could then post to the ledger under another name, the thing `env.ts:8-18` exists to stop) or a key, which reaches identity's blanket doors and works only once the platform runs keys.

Recommended instead: **put the wallet-signed order session in svc-identity**, which already issues and revokes sessions (`auth_flows`, refresh revocation). The browser asks identity for a challenge, signs it, and identity checks it (EOA recovery, or ERC-1271 `isValidSignature` through the same chain read svc-protocol's `claimAccount` uses) and issues a short-lived, revocable session. Edge forwards that principal to svc-dex as it does for every route. svc-dex then calls no one and holds no credential. The `dex.auth.*` codes stay as the contract's names and are served by identity's procedures.

The owner chose this on 2026-10-22, so the D-limit-dca-01 pack's dex-to-identity nonce call is dropped. The option not taken was a key-only svc-dex identity under the standing rule's precondition (blanket doors refuse it first), callers lists on exactly identity's nonce issue/take and session revoke procedures, and sign-in refusing `dex.auth.unavailable` while the platform runs without keys, which includes today's local stack.

### 3.3 svc-academy ledger grant (yes, two recipes)

Paid courses (AC-commerce-01) post through two new recipes in `packages/ledger-client`, `academyPurchase` and `academyRefund`, each moving value only between the buyer and the academy revenue account, module `academy`. svc-academy gets exactly those two grants, cited to its purchase-saga file, in the AC-commerce-01 service PR, plus `txByKey` for its reconciler and no other read door (rule 5). Not `marketPurchase`: that is svc-market's listing flow, and one recipe shared by two services blurs whose module a post belongs to. A blank course price means not purchasable, never free.

### 3.4 svc-p2p reference price (no service edge)

A market price is public data (rule 1). svc-p2p implements `ReferencePriceSource` (`services/svc-p2p/src/pricing.ts:46`) over svc-trade's public price read, the way svc-bank does (`portfolio-service.ts:143`), with a new `TRADE_URL` setting that refuses floating offers when blank. Because a last trade on a thin market can be pushed by one trade, the source returns `null` (and the offer refuses) unless all of these hold: the quote is fresh (its `windowStart` or observed time within an owner-set maximum age; blank refuses floating offers), the market is listed and active, and the price sits inside the owner's guard band from the pack. A mark or index field, if svc-trade's public read carries one, is preferred over `last`. A fiat the venue does not list (for example BTC in NGN with no BTC/NGN market) returns `null`; no FX rate is invented or chained in.

### 3.5 svc-support guest verification email (yes, a separate door)

svc-notify's guest route stays `svc-ops` only (`services/svc-notify/src/guests/router.ts:14-17`). Opening it to svc-support would let either producer read or erase the other's guest rows by business key. svc-notify gets its own procedure, `guestVerification.send`, wrapped in `serviceProcedureFor(['svc-support'])` with the callers list in contracts (rule 4). It sends one message kind, the guest-request verification link; the link must start with the configured customer app origin (blank refuses); rows are tagged with the producer, and get and erase see only the caller's own rows. Business key `support:guest-verify:<guestRequestId>:<n>`. **The link is never stored:** the guest table keeps the full send input as its payload today (`services/svc-notify/src/guests/service.ts:134`), so this procedure stores the token's id and expiry only, renders the link into the email at send time, and a resend takes a fresh link from svc-support under the next ordinal, as `service.ts:197` already requires for token URLs. Not an event, for the same reason.

### 3.6 svc-bank holdings join with svc-tax (no service edge)

`bank.portfolio.holdings` is the signed-in user's own portfolio, and `tax.lotBook` is already scoped to that user (`services/svc-tax/src/router.ts:106`). svc-bank forwards the user's principal to `tax.lotBook` (rule 2) with a new `TAX_URL` setting. A token without `tax:read`, a blank URL or a failed read leaves the cost cells `null` with `tax.cost_basis_unavailable`; the total and allocation still show. svc-bank gets no way to read another user's lots.

### 3.7 svc-ops staff holds (yes, three recipes)

OPS-accounts-desk-01: svc-ops owns the hold desk and its two-person approval, so svc-ops posts the holds. It gets exactly `staffHoldPlace`, `staffHoldRelease` and `staffHoldConfirm`, module `ops`, in the svc-ops hold-store PR after the recipe PR, plus `txByKey` and no other new read door (rule 5; it keeps `feeRevenue` and `restoreWatermark`). The recipes fix the shape of each post: place and release move value only between the same owner's available and held balances; confirm moves at most the remaining held amount, and only to the owner-named account (blank refuses `owner.decision` and nothing posts). The second approver is enforced in svc-ops, through identity's action approval, not by the ledger: a recipe is a pure entry builder and carries the approval id for audit only (compare `packages/ledger-client/src/recipes/bank.ts:353-378`). So the worst a compromised svc-ops can do is move a held amount to the one owner-named account, which the reconciliation and the hold's audit trail show. The closure sweep and loss cover stay with svc-identity, as new grants on an existing caller.

### 3.8 svc-bank `feeCharge` grant (yes, module `bank`)

BK-cops-07 card fees post with `feeCharge` in module `bank`, granted to svc-bank and cited to the card-fee file, in the PR that first posts a fee. The amount comes from the owner's approved fee schedule (blank refuses `bank.card_fee_unset`, nothing posts). Idempotency key `bank:card-fee:<cardId>:<feeEventId>`. svc-agents keeps its own `feeCharge` grant in module `agents`. svc-bank is already a reader, so rule 5's read exclusion does not change anything here.

### 3.9 Edge route for `ledger.transactionGet` (#5786) (yes, named, never a tRPC mount)

svc-ledger keeps serving no tRPC router (`operator-http.ts:41-48`). The read is served as one more raw operator route, `GET /operator/transactions/:txId`, behind the same `guarded` treasury authentication (`admin:treasury` and a second factor) as `/operator/freeze`, with `txId` checked against the ledger's id format before the lookup and one access log line naming the operator and the id. svc-edge forwards it through one named admin route, `GET /admin/ledger/transactions/:txId`, which re-checks the id format and forwards the operator's bearer to exactly that path. `LedgerOperatorCall`'s path type widens by that one path and nothing else. Two PRs in order: svc-ledger (#5786 re-scoped, or a follow-up), then svc-edge (security code, so an independent review).

Amended 2026-10-23 (owner decision): the lookups (`/operator/transactions/:txId` and `/operator/trace`) take a founder's own `admin:read` with a second factor instead of `admin:treasury`, so the console looks up as the founder and the access log names the person. Every other operator route stays on `admin:treasury`. Same order: svc-ledger, then svc-edge.

### 3.10 Edge row for `GET /api/v1/announcements` (yes, after its handler)

The spec pins this URL. Add `{ prefix: '/api/v1/announcements', module: 'notify', envVar: 'NOTIFY_URL', preservePath: true }` to `UPSTREAMS`. `resolve` tries the longest prefix first (`routes.ts:203`), so it wins over `/api/v1` wherever it sits in the list, and killing `notify` stops it. The svc-notify handler does not exist yet (held branch `c2a6316e8`); when it lands it mounts only `GET /api/v1/announcements`, a public read like the notices read, so the row exposes nothing else of svc-notify. Order: the svc-notify handler PR first, then the svc-edge row (security code, so an independent review), with the stack proof showing a 200 through Edge.

### 3.11 BK-cops-03 account freeze read (yes, named)

svc-bank checking whether an account is frozen has no user's request behind it, so it is a named identity procedure with `CALLERS = ['svc-bank']` (rule 4). The account-state route that accepts any verified service (`services/svc-identity/src/index.ts:783`) is not reused for new callers.

### 3.12 OPS-reconciliation-03 reconciliation evaluation feed for svc-ops (yes, one named ledger door; added 2026-10-29)

svc-ops keeps the reconciliation alert store, so it must see every finished evaluation, including ones run by the schedule with no person behind them. Rule 2 does not fit (no user request), and no event carries evaluations today (rule 3). It is a named service call (rule 4) on svc-ledger's service port, `reconciliationEvaluations`, with svc-ops alone in `LEDGER_DOOR_CALLERS`, svc-ledger's existing callers list for its doors (the pattern `feeRevenue` and `restoreWatermark` already use), and a door test that refuses every other caller. It answers reconciliation results only (status, the two sides per asset, period and severity), never an account balance or an entry, and no account list, so it is not the ledger read rule 5 keeps posters away from; 3.7's "no other new read door" stays true for balances, balance lists and history. A later event for evaluations (rule 3) may replace the door.

## Consequences

- No new S2S identity and no new holder of the shared secret.
- Three services gain ledger post grants (academy two recipes, ops three, bank one more), each one recipe, one module and one file, landing with their callers and adding no read door beyond `txByKey`.
- Five of the held calls need no service edge at all (p2p price, bank to tax, and svc-protocol's card tier, `ownerOf` and Lane A reads).
- Two named doors are new (svc-notify guest verification for svc-support; identity freeze read for svc-bank) and two named Edge routes (ledger transaction detail; announcements).
- The journeys these unblock still need their own slices; this ADR only says how the services reach each other.
- New "Design:" questions of the same kind are decided by the rules above and added here as section 3.x.
