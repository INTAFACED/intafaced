# OPS lane closeout — 2026-08-08

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Tip at writing: `0c350d10` (`feat(trade): a futures market can take an order — behind a flag that ships off (#1118)`).
The lane was dispatched against `8519bea5`; four other lanes moved the tip ~15 commits during the session.

**Scope of this lane:** `ops.admin` · `ops.support` · `ops.notifications` · `ops.analytics` ·
`ops.affiliates` · `ops.compliance` — plus the claim release on `tooling/tracker/features.mjs`.
Six mountains, zero built at dispatch. **One shipped; five not started.**

---

## Shipped

**#1122 — the tracker said six mountains were taken, five of the claims were nobody.**
A dispatcher reading the board now gets a true answer about who is inside which mountain. Six
`owner` fields cleared against evidence (no open PR, no branch on origin), two of them released by
Nitro by name; three rows keep their owners deliberately. Two lock mechanisms neutralised and one
false note replaced. Detail below under _the two mechanisms_.

That is the whole of what landed. **Nothing else was built.** The lane spent its time on a
six-way read-only harvest of tip, and the harvest is the substance of this note — the findings
are worth more than another half-finished slice, and they are all any next session needs.

---

## Left open, and why

**#1122** — open, CI running at close. Data + generated docs only; no service code. It was green
locally on `node tooling/scripts/tracker.mjs --check` and on all 27 doctrine gates. If CI is green,
merge it; if the tip has moved, rebase and re-run `pnpm tracker` before merging — `docs/TRACKER.md`
and `README.md` are generated from `features.mjs` and a stale pair fails the check.

No other PR. No branch left unpushed. No worktree left dirty.

---

## Not started

All five. Each entry gives the Done bar, what is actually on tip (re-derived this session, not
quoted from a doc), and the one thing to do first.

### `ops.admin` — the console is NOT a facade, and the tracker was lying about it

**Read first:** `docs/ops/trk/ops.admin.md` §1 (six clauses) and §4 (ten unchecked boxes).
**Done bar, short form:** live control-plane state, kill and freeze that actually stop the platform,
and every other staff tool either calling a real endpoint **or refusing with a visible
"not wired / simulated" marker — never a green success that only flipped local state**.

The brief for this lane, and the `features.mjs` note it came from, said `apps/admin` has zero tests
and makes no network call of any kind. **That was true on 2026-07-28 and wrong since 2026-07-30.**
On tip: 5 test files / ~50 cases; `/` and `/ledger` post through the app's own BFF routes to
svc-edge `/admin/kill-switches` and `/admin/ledger/{freeze,unfreeze}`, which reach svc-ledger
`/operator/freeze`; mounted in `docker-compose.apps.yml` on `:3100` with operator and treasury
tokens. #186, #360, #447 (which _deleted_ the fake freeze path), #436 and #1032 did that. The note
is corrected in #1122.

Exactly one control is inert — `Run reconcile (simulated)` in `ledger-ops.tsx` — and it is already
honest three ways: the button says simulated, the payload field is named `simulated` not `result`,
and `delivered: false` is a literal type. Per-flag switches on the kill board are session previews
and say `Preview` on every row.

**Three things the next session should not get wrong:**

1. **Reconcile is dark at two layers, not one.** svc-ledger never mounts its tRPC router, so
   `ledger.reconcile` has no HTTP surface at all and svc-edge has nothing to proxy. That is three
   PRs under one-service-per-PR (svc-ledger route → svc-edge proxy → admin BFF), not the two the
   TRK board estimates. Leaving it simulated is a legitimate choice — box 3(b) is already satisfied.
2. **"Only `/admin/*` is real" is false and will cause a rebuild.** Roughly twenty genuine operator
   procedures are already mounted and reachable through the ordinary `/api/*` proxy with an admin
   token — the whole `bank.ops.*` block, `token.mintEpoch` / `distributeRevenue` / `recordBuyback`,
   `pay.deposit.credit`, `pay.merchantState.set`, `identity.kyc.approve/reject`,
   `compliance.freezeIdentity/unfreezeIdentity`, six svc-academy operator procedures. Wiring those
   is the largest honest gain available and needs no new service work.
3. **Fee params and listings have no write path anywhere in the platform.** Market rows are written
   by migration only; there is no `insert(markets)` in any non-test source. Governance is a dead end
   — `proposalKind` includes `fee_param` and `listing`, but nothing in the repo can pass or execute
   a proposal. Rendering either as a control would be exactly the failure this row exists to name.

**The real ship gate is not the UI.** Port 3100 is published to the host behind a shared token with
no SSO and no network ACL. That is Class X and no PR closes it.

### `ops.support` — durable store, and it is mostly infrastructure

**Read first:** `docs/ops/trk/ops.support.md` — Done bar at §1, four unchecked boxes at §4.
**Done bar, short form:** a user opens an authenticated ticket; an operator lists/assigns/comments/
resolves without holding or moving balances; both search a KB of our own i18n-keyed articles;
account state is read-only projections, never a second balance store.

Stage 2 is merged (#999), not Stage 1. The KB is not empty — five articles exist with English copy
in `@intafaced/i18n`, and `searchKb`/`getKbById` are written but not exposed on the router, which is
a genuinely small residual.

Tickets and comments are two in-process `Map`s. The restart argument is the weak one; **the argument
that survives is that two replicas behind the edge serve disjoint ticket sets**, and the operator
claim is read-then-write over a Map, so its exclusivity is TOCTOU by construction.

**Durability is not one class of work.** The store itself is ~150 lines against a proven template
(svc-notify: `src/db/schema.ts`, `drizzle/NNNN_*.sql` + mandatory `.down.sql`, `scripts/migrate.ts`,
the memory/Postgres conformance suite). The cost is elsewhere: there is no `support` Postgres schema
and no `svc_support` role in `tooling/infra/postgres-init`, and no `TEST_DATABASE_URL_SUPPORT` in
CI — four shared files other lanes also edit.

One free truth-fix: `services/svc-support/src/env.ts` says "no database" in its docblock while
`serviceEnvSchema` already makes `DATABASE_URL` mandatory to boot. The comment is what is wrong.

**Unnamed in the original brief:** there is no customer entry point at all. `create` is reachable
only as a raw tRPC call through the edge. The customer form must be Vue in the vendored shell — a
new SPA is banned — and that is a different skill and a different (blocking) i18n gate.

### `ops.notifications` — the row is honest; three real holes remain

**Read first:** `docs/ops/trk/ops.notifications.md` §1 (seven points) and §4 (seven boxes), plus
`docs/OWNER-ACTIONS-NOTIFY-GATEWAYS.md`.

The central claim was verified against code, not taken on trust: an unconfigured channel refuses by
typed name **and the refusal is written to the delivery row**, with `attempted_at` left NULL, backed
by a DB check constraint that makes `accepted_at` writable only when `status = 'accepted'`. Four of
the seven boxes are already satisfied in code and unchecked only because nothing is deployed.

**Ranked by value per line, the buildable work needing no credentials:**

1. **A stuck-`pending` reap hole.** The `in_flight` path returns retryable **without incrementing
   `attempts`** — deliberately, and tested. Each such pass still consumes one bus delivery. With
   `max_deliver` 5 and max attempts 3, sustained lease contention burns every bus delivery while
   `attempts` stays at 1–2; JetStream parks the message, and `reapExhausted` requires
   `attempts >= maxAttempts`, so it never fires. The row sits `pending` forever — the exact state
   the sweep exists to remove, reached through a different door. Fix is small: also retire `pending`
   rows whose lease has been dead longer than the bus could still be retrying.
2. **No rate limit on verify or register.** A 6-digit code with a 15-minute TTL and unlimited
   guesses, and no throttle on `registerTarget` — once credentials exist, an authenticated user can
   trigger unlimited SMS to any number they type. Security _and_ billing exposure. The only rate
   limit in the system is a global edge one that is off by default.
3. **The consent footer is dead code.** `notify.channel.footer` exists in the catalog, says exactly
   the right thing, and is rendered by nothing — so outbound messages carry no consent or opt-out
   line at all. Smaller than a preference surface and cannot be dismissed as speculative: the repo
   already decided the line should exist.

Also: no operator view of delivery outcomes (the index for it exists and no query uses it), and six
user-addressable events produce no notification — `protocolSessionKeyCreated` / `Cancelled` is the
strongest case. Adding a consumer means removing its `WIRING_SOCKETS` entry in the same PR.

**Resist wiring the digest/`combined.ts` code.** It is written, heavily tested, and has zero
callers — because its cadence product law is still an open owner decision.

### `ops.analytics` — honest lag does not exist

**Read first:** `docs/adr/2026-08-07-ops-analytics-warehouse-read-replica.md` (**Accepted**,
Class N) and `docs/ops/ANALYTICS-WAREHOUSE-REPLICA-RUNBOOK.md`. Note the two tracker files
(`ops.analytics.md`, `TRK-ops.analytics.md`) disagree with each other on ownership and status.

**Stale in the row and corrected in #1122:** "admin consumer" is listed as residual, but #1032
landed one — `apps/admin` serves `/api/analytics/warehouse` over `queryWarehouseSurface` with 3
tests. It has no UI consumer and is not in the nav.

**The hole, and it is the one that produces a lie:** nothing measures lag. The only supply of
`lagSeconds` anywhere is `ANALYTICS_REPLICA_LAG_SECONDS`, a string an operator types once. Set it
to `5` and the surface reports freshness `live` and `mayLabelLive: true` forever, replica or no
replica. `pg_stat_replication` appears exactly once in the repo, in prose. This is currently
harmless only because the GET path always passes zero facts, so no number is painted — the badge
logic is already wrong. **Build the probe, and give the reading a measurement timestamp, so a stale
lag reading is itself `unknown`.**

Second: `assertAnalyticsReplicaRole` is real, well-tested, recently hardened (#1079 fixed a bypass
where `postgres_root` passed as read-only) — and **has no production caller**. The admin route
reads a self-declared `ANALYTICS_REPLICA_CONFIGURED` boolean and never sees a URL; the three
`ANALYTICS_REPLICA_*_URL` vars in `.env.example` are read by no code. Giving it a caller is what
closes the gap, and the pool should also set `default_transaction_read_only` so the promise is
enforced by Postgres rather than by a username spelling.

Third: `empty` cannot distinguish "the ETL never ran" from "the ETL ran and found nothing" — no
watermark exists, so `empty` overclaims today.

For the cube job, copy `services/svc-trade/src/spot/candle-jobs.ts` and its `job-host.ts`: the
double gate (`enabled` **and** a non-empty explicit target list, so an enabled job with no targets
schedules nothing) and the off-by-default env idiom are both already tested there.

### `ops.affiliates` — a DIRECTION §8 rate was invented and is being persisted

**This is the most serious finding of the session and the first thing the next lane should fix.**

**Read first:** `docs/ops/trk/ops.affiliates.md` §1 and its Slice B/C boxes.

`affiliates/commission.ts` defines `DEFAULT_ACCRUAL_TIERS` — **10% / 5% / 2%** fee-share rates —
as the fallback when a caller omits `tiers`. The mounted `affiliates.accrue` procedure
(`admin:write`) uses that fallback and **writes durable rows** into
`identity.affiliate_commission_accruals`. Nobody published those numbers. DIRECTION §8 item 10
reserves "every other fee-share rate" to the owner, and this row's own non-goal forbids a commission
percentage without fee events.

The refuse-closed gate was fitted to `payout` only. **The invented number enters at accrual**, which
is where a claim on real money is created; payout is merely where it leaves. And it is test-locked —
the suite computes expected values from the fake rates — so removing it reddens tests. That is how
an honesty debt becomes load-bearing.

**Removing it is Class N, needs no owner number, and can ship immediately.** Port the discriminated
union from `services/svc-trade/src/copy/fee-share-law.ts`, where `published: false` makes the rate
_unreachable in the type system_ rather than merely unset, plus the env parse (blank → unpublished,
malformed → fail boot) and the named residual constant.

Two more, previously unrecorded:

- **The cycle check is TOCTOU.** `attribute` loads the parent map, decides, then inserts — no
  transaction, no lock. Two accounts referring each other concurrently both pass and both insert.
  The PK stops double-parenting and the CHECK stops self-reference, but **nothing in the database
  stops a 2-cycle**. Once written, every read path throws `referral.cycle` and that subtree bricks
  with no repair procedure. Cheap collusion vector.
- **`listByBeneficiary` is written, indexed, and reachable from no procedure** — an affiliate cannot
  see their own earnings. Do not build the statement surface before the rate law is fixed, or it
  will show users fabricated money they may believe they are owed. Order matters.

For payout: reuse `rewardPay` and `sweepFeesToRewards` **unchanged**. Adding or changing a ledger
recipe is a DIRECTION §8 carve-out and stops being agent-mergeable. Key the ledger post off the
accrual's own identity so the ledger's unique index becomes the double-pay guard, and add the
paid-marker column _before_ anything is paid — retrofitting one onto already-paid rows is
unrecoverable.

### `ops.compliance` — unknown region fails OPEN, and no request has ever been screened

**Read first:** `docs/ops/trk/ops.compliance.md` (Done bar §1, six boxes across slices A/B/C) and
`tooling/tracker/features.mjs` → `socket.geo-region-resolution`, which is the most accurate document
in the repo on this title. The row itself is bare and free.

**The finding, and it is load-bearing:** svc-edge stamps `region: env.DEFAULT_REGION` onto the
principal of **every** request — one constant, read once at boot, defaulting to `'XX'`. `'XX'` has
no `JURISDICTION_MATRIX` entry, so it falls through to the default rules, which are `open` for every
module. The `{ region: '*' }` seed is inert — it is keyed literally and the only code that touches
it filters it out. There is no wildcard fallback.

This is not an inference: svc-protocol asserts at boot that `checkAccess({region:'XX'})` returns
`allowed.permissionless` and **refuses to start if it does not**. Unknown-region-is-allowed is a
load-bearing boot invariant. Note `services/svc-edge/src/env.ts` claims `XX` is treated as unknown
and therefore "restrictive rather than permissive" — **that comment is wrong**; the matrix treats
`XX` as _no entry_, which is maximally permissive.

No IP is ever read for geo. `req.ip` is used only by the rate limiter, and `EDGE_TRUST_PROXY` is
unset by default, so out of the box it is the load balancer anyway. No `cf-ipcountry`, no MaxMind,
no provider anywhere in the tree.

What _is_ good and should not be touched: the two-authority split (business `JURISDICTION_MATRIX`
vs counsel-supplied `ScreeningList`, deliberately un-mergeable types), the fail-closed `unset`
handling, and the ordering in `checkAccess` that screens region _before_ the permissionless
short-circuit. Sovereign ≠ unscreened is genuinely implemented. It is just evaluating a constant.

**Highest-leverage safe move, and it is pure mechanism with zero Class X content:** `AccessDecision`
has no `denied.region_unknown` and no `regionResolved` flag. `ScreeningProvenance` tells you whether
a _list_ was consulted but not whether the _region_ was resolved — two different unknowns, and the
decision object currently conflates the second into silence. Adding `regionResolved` mirrors exactly
the `configured`/`declaration` honesty that already exists for lists, and it is the prerequisite for
any fail-closed answer.

**Two traps.** (1) Slice A as written points `apps/admin`'s `jurisdiction-board.tsx` at a screening
panel — but that component is `'use client'` and imports `JURISDICTION_MATRIX`/`checkAccess`
directly from `@intafaced/config`, so it renders build-time config in the browser's empty env and is
_structurally incapable_ of reporting the truth. The honest version already exists server-side on
svc-edge `/ready`, which deliberately exposes the blocked-region **count, never the codes**.
(2) `svc-support`'s operator queue looks like the queue prior art and is in-memory; the pattern to
copy is svc-identity's KYC queue — a status+created_at index named as the queue, a FIFO
`listPendingKyc`, and a decision under `transaction` + `SELECT … FOR UPDATE`. For the audit trail,
svc-p2p disputes (append-only evidence with `seq` under a row lock, enforced by a DB trigger) is the
strongest pattern in the repo.

VPN/Tor: **nothing exists — zero code, zero stub, zero env var.** Detection is not honestly possible
without a commercial data feed, which is a credential and commercial decision. The correct move is
Slice C's second option: name the residual or narrow the title. Do not ship a heuristic.

---

## Only Nitro can decide

1. **The affiliate / IB commission rates** — DIRECTION §8 item 10. Blank. The mechanism can be made
   refuse-closed without them (and should be, immediately); the numbers cannot be inferred, and one
   set is currently invented in code.
2. **Notification gateway credentials** — push, email and SMS. Class X. The adapters are built,
   tested and merged; they are waiting on two strings per channel. Also his: which provider and
   jurisdiction, whether SMS is required at all, and any user-facing "delivered" wording.
3. **Sanctions list content** — the regions, and the `INTAFACED_SANCTIONS_LIST_SOURCE` provenance
   string. Class X, his and counsel's. Writing `INTAFACED_SANCTIONS_REGIONS=none` plus any source
   string _is_ a compliance determination expressed as two env vars; no agent should ever populate
   either, in any env file, fixture or compose default.
4. **The admin console's production exposure** — `:3100` is published to the host behind a shared
   token with no SSO and no network ACL. Whichever way this goes (SSO, IdP choice, network ACL, who
   may hold `admin:treasury`) it is Class X and no PR closes it.
5. **A VPN/Tor data feed, if the title is to be kept** — commercial and credential. Otherwise the
   honest move is to narrow the tracker title, which is an ordinary PR.
6. **Geo region resolution topology** — closing `socket.geo-region-resolution` needs a named trusted
   upstream (which CDN fronts the edge), a stated header precedence, proof there is no
   direct-to-origin bypass, and a fail-closed answer when the header is absent. Small code, and the
   decision is not an agent's.

Not on this list, deliberately: **`trade.copy`, `trade.algo` and `connect.venue-vault` keep their
owners.** Their residuals genuinely are owner decisions or key custody, so their claims describe
reality. They were left alone in #1122 for that reason, not by oversight.

---

## What I could not break, having tried

- **`ops.notifications` refusal honesty.** I set out to find that an unconfigured channel silently
  succeeds, because that is the failure this repo keeps finding. It does not. The refusal is typed,
  it is written to the delivery row, `attempted_at` is left NULL to keep "nowhere to send it" apart
  from "the provider was down", and a database check constraint makes `accepted_at` writable only
  when the status is `accepted` — so a silent success would have to lie in two columns at once and
  Postgres would reject the row. There is a test that reads the row rather than the return value,
  and a wire test asserting zero HTTP requests were made. The one narrowing worth carrying: this
  holds for notification dispatch, **not** for the address-confirmation send, which calls the
  adapter directly with no claim and no delivery row, so that refusal returns to the caller and
  vanishes.
- **`apps/admin` as a facade.** This was the lane's headline assignment and the premise did not
  survive contact with the tree. There is no `useState` in that app that pretends to be an
  operation — every local-only control is a form field, a labelled preview, or a pure calculator.
  The one inert control announces itself three ways. The tracker was wrong, not the code.
- **The affiliate referral tree as an infinite-loop risk.** I expected an unguarded walk. Every
  walker is `seen`-guarded, including a corrupt-graph fallback that returns "cycle" rather than
  spinning, there is a depth cap of 5 enforced on both paths, and self-referral is blocked in the
  application _and_ by a database CHECK. The real defect there is concurrency, not traversal.
- **`checkAccess` ordering.** The claim that region screening runs before the permissionless
  short-circuit is true, is commented as load-bearing, and is asserted at boot by two services.
  Sovereign does not mean unscreened, exactly as documented — the failure is upstream, in what
  `region` contains.
- **`packages/ledger-client` money law compliance across the ops surfaces.** Nothing in this lane's
  six mountains moves value outside `ledger-client`, and `apps/admin` imports it nowhere. The
  console issues commands; svc-ledger posts. That boundary held everywhere I looked.

One thing I did **not** verify empirically, and will not claim: no test suite was executed. The
database suites are CI-only on this machine (~42 skip locally), so every "tested" statement above is
read from source, not from a run. All 27 doctrine gates and `tracker --check` did run, and passed.

---

## Practical notes for the next session

- **`pnpm` is not on the default PATH here.** It lives at `/Users/Nitro/projects/Sovereign/.tools/bin/pnpm`.
- **Another lane's `worktree-gc --apply` deleted two of this lane's worktrees mid-edit**, along with
  an unpushed branch. The GC removes any _clean_ worktree whose HEAD is an ancestor of main — which
  a freshly created one always is. **Commit and push a branch the moment you create it**; that is
  what makes it survive.
- Harvest reports for all six mountains were produced read-only against a detached tip worktree.
  That worktree is gone; the findings above are the durable record of them.
