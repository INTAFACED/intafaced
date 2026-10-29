# svc-market

Vendor lifecycle for `market.vendors` (§8.7) plus listings and one-time purchase
for `market.commerce`. **A user applies to be a marketplace vendor, an operator
vets the application, an approved vendor holds listing slots their IFC stake
tier pays for, a stranger can see who is listed, a listed vendor publishes a
priced listing, and a buyer pays via ledger recipes with a disclosed house
commission.**

Doctrine: §0.6 no balances here; §2 no SQL into another service's schema; the
stake numbers stay in svc-token; value moves only through `packages/ledger-client`.

## Stages

| Stage  | What it is                                                 | Built |
| ------ | ---------------------------------------------------------- | ----- |
| **1**  | Apply → vet, with an append-only decision history          | **✓** |
| **2**  | Stake-gated listing slots, from `vendorSlots` under a lock | **✓** |
| **3**  | Public listing eligibility, feeding `market.commerce`      | **✓** |
| **C1** | Listing catalog (no money)                                 | **✓** |
| **C2** | One-time purchase + house commission (Class M)             | **✓** |
| **C3** | Subscriptions                                              | **✓** |

## API

tRPC under `/trpc` (edge mounts `/api/market`). Principal via edge HMAC
(`EDGE_PRINCIPAL_SECRET`).

| Procedure                  | Scope          | Behaviour                                                                                                     |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `profile`                  | **public**     | One listed vendor's public profile                                                                            |
| `listed`                   | **public**     | The directory of vendors listed right now                                                                     |
| `listing`                  | **public**     | One shopfront listing by id: terms, seller profile, review summary. No seller user id. No performance figure. |
| `listings`                 | **public**     | Active sellable listings (one-time + perioded subscriptions)                                                  |
| `listingCategories`        | **public**     | Product category enum (not an owner env list)                                                                 |
| `listingsByCategory`       | **public**     | Short page of active one-time listings in one category                                                        |
| `commerceProgramme`        | **public**     | Whether house commission bps is configured                                                                    |
| `applyAsVendor`            | `market:write` | Create the caller's own application (`applied`)                                                               |
| `mine`                     | `market:read`  | The caller's own application, or `null`                                                                       |
| `createListing`            | `market:write` | Create a listing; claims a slot named by the listing id                                                       |
| `createNonStrategyListing` | `market:write` | One-time listing that names a product category slug                                                           |
| `ops.setListingCategory`   | `market:ops`   | MFA + reason; audit row; idempotent on the business key                                                       |
| `archiveListing`           | `market:write` | Archive own listing; releases its slot                                                                        |
| `myListings`               | `market:read`  | Caller's listings                                                                                             |
| `purchase`                 | `market:write` | One-time or one-period subscription purchase (`purchaseId`)                                                   |
| `myPurchases`              | `market:read`  | Caller's purchases                                                                                            |
| `refundPurchase`           | `market:write` | Ask for the whole amount back on a held purchase, inside its refund window                                    |
| `cancelSubscription`       | `market:write` | Stop new access; no ledger reverse                                                                            |
| `subscriptionAccess`       | `market:read`  | Time-bounded grant, or named past-due / cancelled                                                             |
| `claimSlot`                | `market:write` | Take a listing slot, if the caller's tier has one                                                             |
| `releaseSlot`              | `market:write` | Give a slot back                                                                                              |
| `slots`                    | `market:read`  | Tier, capacity, held and **usable** slots                                                                     |
| `listApplications`         | `market:ops`   | Operator queue — undecided first, oldest first                                                                |
| `vet`                      | `market:ops`   | Record an operator's decision and apply it                                                                    |
| `history`                  | `market:ops`   | The decision trail for one application                                                                        |

HTTP: `GET /health`, `GET /ready` (`stage: commerce-subscriptions`, plus whether commission is configured).

Neither `claimSlot` nor `releaseSlot` takes a `vendorId`: a slot is always spent
against the caller's own vendor row. A claim that could name its vendor would let
anyone burn somebody else's capacity, and the refusal would land on the victim.

`applyAsVendor` and `mine` carry `{ module: 'market' }`, so the JURISDICTION_MATRIX is
enforced: `market` is OPEN_BASIC, so an applicant needs verification tier
`basic`. The operator procedures deliberately do not — a desk operator's
authority is `market:ops`, not their own KYC tier.

`profile` and `listed` carry neither a scope nor the matrix guard. They are the
shopfront: svc-edge forwards a request with no token as ANONYMOUS, so these
resolve for somebody who has never signed up, which is the whole audience. The
matrix asks "may this USER apply/list here, at their verification tier" and an
anonymous reader is not a user. Halting the module still lands first — `/api/market`
is in svc-edge `UPSTREAMS`, so the kill-switch closes the door in an `onRequest`
hook, before any of this code runs.

### What this service will not decide

**There is no vetting criterion here, and there must not be one.** No rule exists
anywhere in this repository for what makes an application good;
`docs/ops/trk/market.vendors.md` (removed) named it an open product question that belongs
to the owner. So `vet` takes an operator's decision and their reason, records
both, and applies the state — a log with a side effect, not a decision engine. A
caller that reaches `VendorService.vet` without holding `market:ops` is refused
with **`market.vet_operator_required`**, including a future policy engine or an
internal script. Precedent: `pay.kyb_operator_required`.

**There are still no stake numbers here.** Slot capacity is READ from svc-token,
never stored. The tier table (`vendorSlots`) belongs to
`services/svc-token/src/economics/staking.ts`, and no threshold, slot count or
tier name appears in this service or its schema — a second copy of a stake
schedule is a second answer to "may this vendor list", and the two diverge on the
first tuning change.

**There is no suspension policy.** `suspended` is a state an operator may set
with a reason. Nothing here decides when that should happen, on a timer or
otherwise. Any transition between decided states is permitted, because a
transition map is itself a policy nobody has ruled on. Stage 2 RELEASES a
vendor's slots when they leave `approved` — reacting to a transition an operator
recorded is not the same as deciding it.

## Stake-gated listing slots (Stage 2)

Capacity is `AccessTier.vendorSlots`, read from svc-token's
`GET /internal/stake/:userId` at claim time and again on every read. Not the tRPC
`token.stakeOf` — that is `scopedProcedure('token:read')` and self-only, and
svc-market does not hold the user's principal.

**Fails closed.** Network throw, non-2xx, an unusable payload, a `vendorSlots`
that is not a non-negative integer — all four refuse with
`market.stake_unavailable` rather than guessing a capacity. `slots` refuses too: a
read that cannot verify entitlement must not report a vendor as listable.

**No amount crosses the boundary.** The endpoint returns `staked` and
`tier.minStake` as decimal strings; this service reads NEITHER, because it needs
a capacity and not a balance. That is also the safest position on the bug PR #1100
fixed — a field that is never read cannot be accidentally re-scaled.

**Depends on PR #1100 (merged).** That PR fixed
`/internal/stake/:userId` returning HTTP 500 for every caller (`AccessTier.minStake`
was a bigint and Fastify's `JSON.stringify` fallback threw). Fail-closed still
holds: any remaining non-2xx / unusable payload is `market.stake_unavailable`,
not free capacity.

### Capacity cannot be oversold

`claimSlot` locks the vendor row `FOR UPDATE`, counts open slots, decides, then
inserts — one transaction at `read committed`, the same pattern as
`svc-academy`'s seat claim. The proof is
`src/vendor-slots.test.ts`: eight simultaneous claims against a tier of three
admit exactly three and refuse five by name. **That suite needs Postgres and
skips without it** — a local run with no Docker has not proved this.

The stake lookup happens **before** the lock, deliberately: it is a network call,
and holding the vendor's busiest row across one would serialise every claim behind
svc-token's latency. A slightly stale ENTITLEMENT can only admit a claim the
vendor was entitled to moments ago; what must be fresh is the OCCUPANCY, and that
is counted inside the lock.

`ref` names what the slot is for and makes a claim idempotent — a retried request
must not consume a second slot for the same listing, which is overselling by a
different route. Stage 3 sets it to a listing id.

### Release, and why there is no unstake subscriber

Slots are released three ways: the vendor releases one, or an operator moves them
out of `approved` (released in the SAME transaction as the transition — split
across two, a crash leaves a suspended vendor holding every slot), or **they stop
counting** because capacity is re-derived on read.

That last one is the honest mechanism for unstaking. svc-market never learns that
somebody unstaked: there is no accepted bus subject for it, `event-wiring.mjs`
correctly reds on a subject with no publisher, and polling svc-token on a timer
would be a second source of truth that is wrong between ticks. So `slots` reports
`usable = min(held, capacity)`, and `0` for anyone not `approved`. A vendor who
drops to Base reads `usable: 0` immediately, which is what makes "under-staked
vendors cannot present as listed" hold whether or not a release ever happened.

## Public list eligibility (Stage 3)

**A vendor is listed if they are approved, hold at least one open slot, and their
CURRENT stake tier still covers at least one of those slots.** Computed on every
read. There is no `is_listed` column and there must not be one, for the reason
`services/svc-p2p/src/reputation.ts` gives about badges — _"a badge that can only
be granted is a badge that lies"_. A stored flag is right until the fact under it
changes and nothing runs, and for unstaking nothing ever runs: svc-market is
never told. The flag would then read `listed` for a vendor whose entitlement is
gone, which is DoD clause 5 failing while looking fine.

The under-staked case is the one the clause exists for. A vendor claims three
slots at Operator, unstakes to Base, and **nothing releases those rows** — Stage 2
deliberately has no unstake subscriber. They are not listed anyway, because
`usableSlots` clamps what they hold to what svc-token says their tier covers this
second. `src/listing-eligibility.test.ts` asserts the three slot rows are still
open before asserting the vendor has vanished from the marketplace, so the test
cannot pass by the rows quietly disappearing.

**A partial drop still leaves them listed**, and that is deliberate: somebody at
Initiate is entitled to a slot. Which of an over-held vendor's listings stays
live is `market.commerce`'s: **oldest open slot first** (`claimed_at ASC`), count
= current usable capacity. Excess listings stay in `myListings` but drop from the
public catalogue and refuse purchase with `market.listing_over_capacity`.

### What a stranger sees

Four fields: `id`, `displayName`, `description`, `createdAt`. Every omission is
argued in `PublicVendorProfile` — no `userId` (joins a storefront to a person's
account across every module), no `status` (always `approved` when a profile
exists, so the only thing it could carry is that somebody else was suspended), no
tier or slot counts (a tier name is a public statement about the size of
somebody's holdings), no slot `ref`s, and **nothing whatsoever from
`market.vendor_status_events`** — the vetting reason, the operator's id and the
scope they held stay behind `market:ops` where Stage 1 put them.

`profile` answers **one NOT_FOUND for every reason**: unknown id, never approved,
suspended, rejected, holds no slot, unstaked. A caller that could tell those apart
could enumerate everybody an operator has thrown off the marketplace.

### The `market.commerce` seam

`VendorService.listingEligibility({ vendorId })` or `({ userId })` — a method, not
only a procedure. **Public catalogue and purchase** re-read it so an unstaked or
suspended vendor cannot present as listed or sell. It returns a verdict with a
code commerce can act on (`market.vendor_not_found`, `market.vendor_not_approved`,
`market.slot_required`, `market.stake_required`) rather than throwing, because a
refusal that arrives as an exception gets flattened into a 500 that tells the
vendor nothing.

**Create listing does not use `listingEligibility`.** A vendor is listed only
after they hold a usable slot; the first listing is what claims that slot.
Create gates on **approved vendor** + successful `claimSlot({ ref: listingId })`.
Using eligibility on create would refuse every first listing with
`market.slot_required` (chicken-and-egg). Purchase and catalogue still require a
live open slot with `ref = listingId`, so a crash between insert and claim cannot
sell an orphan row.

`market.stake_unavailable` is the exception, and it is **thrown**: "we could not
check" is not a finding about the vendor and must never be recorded as one. A
caller handed `stake_required` during an svc-token outage would tell an honest
vendor to go and stake.

### Fail closed, ordered so an outage costs as little as possible

Every locally-decidable fact is settled before the network call, so a suspended
vendor, a rejected one, an unknown id and a vendor with no slot are all answered
**without** svc-token. Only callers whose answer genuinely depends on the stake
read can be affected by an outage.

When it is affected: the directory drops that vendor and keeps going — one flaky
lookup costs one vendor, and a total outage returns an empty page. **Nobody
appears rather than everybody.** The single `profile` read throws instead, and
reaches the caller as a 500: a 404 there would assert the vendor does not exist,
which is false and cacheable. That path is tested against a `node:http` server
returning the exact 500 `GET /internal/stake/:userId` produces on `main` today.

One stake read per candidate, capped at 50 a page. If the directory ever takes
real traffic the upgrade is a **batch** entitlement read on svc-token — never a
cached `is_listed`.

### The order is deliberately boring

`created_at ASC`, tie-broken by id. Registration order: already in the database,
and the public `listings` catalogue uses the same registration order (not newest-first) —
stable under pagination, and it says nothing about how good anybody is. Ranking,
quality scoring and featured placement are reserved to the owner by
`docs/DIRECTION-2026-07-31.md` (removed) §8, and choosing one here — even "newest first",
which is a growth choice — would be this service deciding listing policy. A
public list is not a ranked list.

A page can come back shorter than `limit`, because the entitlement filter runs
after it. Back-filling would mean paging svc-token until the page was full, which
turns one slow lookup into an unbounded number of them.

## Events

**None published, none consumed.** No accepted bus subject exists for vendor
lifecycle or market purchases yet. Declaring a subject with no publisher is an
orphan the wiring gate correctly refuses. Unstake has no bus subject either —
eligibility re-reads svc-token live instead.

## Service keys (S2S v3)

With `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` set, the calls to svc-ledger are signed with svc-market's own key, and the ledger names the caller from that key. `dual` also sends the shared secret; `keypair` sends the key signature only. Unset, the ledger calls are signed with the shared secret as before. The calls to identity and token still use the shared secret and move in their own PRs. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Ledger

**Vendors half moves no value.** Slot capacity is not money. **Commerce half**
depends on `@intafaced/ledger-client` and posts only `recipes.marketPurchase`
(buyer → vendor net + `houseFees('market')`) and, with the refund window set, the
held-purchase recipes `marketPurchaseHold`, `marketPurchaseRefund` and
`marketPurchaseRelease`. Market tables hold no balances —
price and commission_bps are intent records. The house rate is owner-gated via
`MARKET_HOUSE_COMMISSION_BPS` (no default).

## Schema

`market.vendors` — one row per **user** (`user_id` UNIQUE), the reversible answer
to the org-vs-user question the spec leaves open.

`market.vendor_status_events` — append-only, enforced by a database trigger, with
both sides of every transition, a required non-blank reason, the operator's id
and the scope they held. A correction is a new row, never an edit: a history that
can be rewritten looks like evidence and is not.

`market.vendor_slots` — one row per claimed slot, released by setting
`released_at` rather than by deletion, so occupancy stays a `COUNT` over live rows
instead of a maintained counter that can drift. **No capacity, tier or threshold
column** — that is svc-token's, read live. A partial unique index on
`(vendor_id, ref) WHERE released_at IS NULL` makes "one open slot per listing" a
database fact for any future path that does not take the lock.

A slot table rather than counting listings: Stage 2 shipped before commerce, so
oversell was provable with opaque `ref`s alone. Commerce now writes the listing
id into `ref` on create. Schema also has `market.listings` and `market.purchases`
(migration `0002_market_commerce.sql`).

## Observability

OpenTelemetry spans via `withMarketSpan` (`intafaced.money_path=false`, module
`market`). SLO residual: one Grafana panel for application and decision rates —
ops backlog, not a Stage-1 ship gate.

## Kill-switch

Flags `market.listings` and `market.vendorApplications` are `NOT_ENFORCED` — the
live control is the edge kill-switch, which works because `/api/market` is in
`UPSTREAMS` (`services/svc-edge/src/routes.ts`). Nothing here reads the flags,
and the flag registry's own comment says so out loud rather than implying
otherwise.

## Commerce money path (Class M)

| Recipe                  | Reason                     | Accounts                                                      |
| ----------------------- | -------------------------- | ------------------------------------------------------------- |
| `marketPurchase`        | `market.purchase`          | buyer available → vendor available + `houseFees('market')`    |
| `marketPurchaseHold`    | `market.purchase.held`     | buyer available → buyer escrow `market:purchase:<purchaseId>` |
| `marketPurchaseRefund`  | `market.purchase.refunded` | buyer escrow → buyer available                                |
| `marketPurchaseRelease` | `market.purchase.released` | buyer escrow → vendor available + `houseFees('market')`       |

- **Idempotency:** `market.purchase:<purchaseId>` (client-supplied).
- **Categories:** product enum in `@intafaced/contracts` — `bots`, `defi`,
  `compliance`, `payment_extensions`, `security_custody`, `data`, `advisory`,
  `partner_integrations`. Not an owner env value. There is no
  `MARKET_LISTING_CATEGORIES`. An unknown slug is `market.category_invalid`.
  `createListing` with `offerType: 'one_time'` may omit the category; null means
  uncategorised, and a category is checked only when one is given. Existing rows
  stay null. `createNonStrategyListing` still requires a slug (blank is
  `market.listing_category_unset`). Strategy listings stay uncategorised for now.
  `listingsByCategory` is a short page; a cursor for that page of category
  results is a later slice. `ops.setListingCategory` needs `market:ops`, MFA, and
  a reason. The slug and an audit row (actor and reason) commit in the same
  transaction, idempotent on the business key. The column is not seeded.
- **Commission:** `MARKET_HOUSE_COMMISSION_BPS` — **no in-code default**. Unset
  refuses `market.commission_not_configured` on **createListing** and fresh **purchase**
  before any row, slot claim, or post; **public catalogue returns []** so the
  shopfront never advertises unsellable stock. Owner published **`0`** in
  `.env.example` (2026-08-13 explicit free-cut). Compose pass-through only
  (`${MARKET_HOUSE_COMMISSION_BPS:-}`) and wires `LEDGER_URL` to `svc-ledger`.
- **Rounding:** floor on commission (customer favour); buyer pays exactly the
  listed price (vendor net + house = price).
- **Eligibility:** catalogue and purchase re-check `listingEligibility` plus a
  live slot `ref = listingId` — never a stored `is_listed`. Create uses
  approved + `claimSlot` (see seam above). Purchase re-checks again immediately
  before the ledger post (stake/suspend TOCTOU close).
- **Crash re-drive:** a pending purchase settles from the **claim snapshot**
  (buyer, payee, asset, price, commission and period on the row), not a later
  listing or env rate. A matching rich ledger receipt can finish a committed
  purchase after fresh selling gates close. The deployed HTTP ledger port has
  no receipt lookup: without that proof, current fresh gates still apply.
  Post errors retain the pending claim, including a later insufficient-funds
  response after an uncertain earlier attempt. Settle updates only while
  `status = 'pending'`; terminal status and original claim terms are protected
  by the database.
- **Subscriptions:** `createListing(subscription)` requires `periodSeconds` (whole
  seconds, no default month). Unset period refuses `market.subscription_period_unset`
  before insert or slot claim. Purchase of a perioded subscription posts the same
  `marketPurchase` recipe as one-time; the period is snapshotted at claim.
  Access starts at the later of settlement or the previous paid window's end;
  concurrent renewals serialize that calculation. Cancel
  (`cancelSubscription`) stops new access and does **not** reverse the ledger.
  After the window, access refuses `market.subscription_past_due` (or
  `market.subscription_cancelled` if cancelled). Leftover rows without a period
  stay off the public catalogue. Automatic recurring `subscribe` still refuses
  `market.subscription_recurring_not_built` (no second recipe / scheduler).

### Held purchases and refunds (J-more-catalogue-02 #4 to #6)

- **Owner setting:** `MARKET_REFUND_WINDOW_SECONDS` (whole seconds, 1 to 31536000) — **no default**.
  - **Set:** `purchase` posts `marketPurchaseHold` (key `market:hold:<purchaseId>`): the price waits in the
    buyer's own pot for that purchase and the seller is paid nothing yet. The purchase settles with a
    `market.purchase_holds` row whose window ends that many seconds after the settle. The window is part of the
    claim snapshot (`purchases.refund_window_seconds`, immutable), so a retried claim posts what the first chose.
  - **Blank:** a direct sale (`marketPurchase`), as before, and `refundPurchase` refuses
    `market.refund_policy_unset`.
- **Refund:** inside the window the buyer may ask once for the whole amount (`marketPurchaseRefund`, key
  `market:refund:<purchaseId>:1`). The ask is written to the hold row first, then posted, so a crash between the
  two still ends in the refund. A retry returns the same refunded hold. Refusals: `market.purchase_not_found`
  (not the caller's), `market.purchase_not_refundable` (sold directly), `market.refund_window_closed` (window
  over or released).
- **Release:** every 30 s the service finishes due holds: an asked-for refund posts first; otherwise, once the
  window has ended, `marketPurchaseRelease` (key `market:release:<purchaseId>`) pays the seller net and the house
  the snapshot commission, then the affiliate legs fire. A row another worker holds is skipped. A failed post
  leaves the pot held for the next run under the same key.
- **One live hold:** buying a listing again while a purchase of it is held or settling refuses
  `market.purchase_already_held`, before anything posts (an advisory lock per listing and buyer, and a partial
  unique index).
- **Reads:** `myPurchases` returns `refundWindowSeconds` and `hold`. Seller earnings and ops sales count a held
  purchase only once released (earnings name the release post). A refunded hold grants no access.
- **Schema:** `0012_market_purchase_holds.sql`. Hold terms are immutable, final states are locked, an ask cannot
  be withdrawn and blocks a release, and rows are never deleted. The reversal refuses
  (`market.purchase_hold_downgrade_refused`) while any purchase was claimed with a window.

No balance column exists on `market.listings` or `market.purchases`. Price and
commission_bps are intent records; the only balances live in svc-ledger.

Safeguard upgrades preserve existing paid rows and leave unknown legacy periods
NULL. Contradictory status, payee, or access data refuses validation instead of
being rewritten. Native migration tests require an explicit `TEST_DATABASE_URL`
and create their own databases. Test-only policy fixtures configure screening
off; the signed mount control restores the strict default and refuses blank
screening before service work.
