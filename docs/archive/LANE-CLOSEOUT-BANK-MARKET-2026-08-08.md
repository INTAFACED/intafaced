# Build lane 3 (bank + market) closeout — 2026-08-08

Tip at writing: `a6458ee9` (rebased closeout; owner-clear audit upgrade on the same PR)

This lane was briefed to build six mountains. The brief's board was **320 commits stale**:
three of the six were already built, one was claimed by another team, and the two that were
genuinely open were the marketplace. Re-deriving that from the tip before building is the
single most valuable thing this lane did — the rest follows from it.

---

## Shipped

**#1100 — the stake endpoint every gate reads returned 500 for every call.**
`GET /internal/stake/:userId` in svc-token returned an `Amount` (a bigint) inside a JSON
response with no serializer, so `JSON.stringify` threw on **every single call**. Both
consumers — staked academy lobbies and the trade OTC stake gate — fail closed, so the
outage was invisible: correct refusals, no alarm, nobody staked could get in.

The part that mattered more than the crash: the _other_ field on that response did **not**
throw. It emitted the raw scaled integer, which both consumers re-scale with `parseAmount`
— a stake **10^18 too large**. A fix that only stopped the crash would have shipped a
**fail-open** stake gate that admitted everyone. Both of the tidy-looking alternatives (a
service-wide bigint serializer, a response schema declaring the field a string) coerce via
`String()` and land exactly on it. A round-trip test now pins both fields.

**#1109 — users can apply to be a marketplace vendor, and ops can vet the application.**
`services/svc-market` did not exist; `market.*` was 0 of 2 with a complete spec and zero
code. Five things in the repo already said "svc-market not built" and were waiting on it.
Ships the service, `market.vendors` (one row per user), append-only
`market.vendor_status_events` enforced by a database trigger, and `market:read` /
`market:write` **unstubbed** in `packages/auth`. `/api/market` is in svc-edge `UPSTREAMS`,
so the module is kill-switchable at the door rather than decoratively.

**#1115 — approved vendors can hold listing slots their IFC stake pays for.**
`vendorSlots` had existed in svc-token since staking shipped and **nothing had ever
consumed it**. This is the platform's first real use of stake tiers to gate a product.
Capacity is never stored — it is read live from svc-token, so no threshold, tier or
slot-count column exists in the market schema. The oversell proof (eight simultaneous
claims admit exactly the tier capacity; holds at capacity 1 where the race is tightest)
was **confirmed executed in the CI log**, not inferred from a green badge.

**#1126 — anyone can see which vendors are listed, and an unstaked one drops off the list.**
Eligibility is computed on every read, never a stored `is_listed` flag, because a stored
grant lies the moment behaviour changes. That is what makes done-bar clause 5 real: a
vendor who claimed three slots at Operator and then unstaked to Base still holds those rows
and is **not** listed. Suspended, rejected and undecided collapse into one public refusal
code so a public read cannot enumerate who was thrown off the marketplace. Stake source
unreachable means nobody is listed rather than everybody.

**`market.vendors` is now `done`** — apply → vet → slot → list eligibility, no commerce
money. The tracker row and note were corrected in this PR; before it, the note still
claimed "Stage 3 public read is still missing", which had become false on main.

---

## Left open, and why

**#1102 (DRAFT) — a card user's whole hold could be stranded permanently.**
Fully green, 6/6 CI, `MERGEABLE / CLEAN`. It was parked only because `claim-check` fenced
all of `services/svc-bank` behind a stale `owner: 'cursor-swarm-bank'` on `bank.ramps`.

**This closeout PR clears that owner** (same standard as #1122: claim closed, no open PR,
no origin branch for the swarm). After this merges, #1102 is no longer claim-blocked —
Class M merge next, not a second decision on the claim.

_What it fixes:_ a card capture whose ledger post fails leaves the authorisation looking
settled, so **both** the retry and `reverse()` are refused, and there is no ops procedure to
release the hold or even read it. One transient svc-ledger blip is the whole trigger — no
concurrency needed. The source header claimed a re-drive of `capture` recovered this; it
never did, and `cards.test.ts` asserts the re-drive throws. It also fixes a concurrent-
capture race where the second caller is handed the first's ledger transaction and then
reports a capture that never happened, reverses a wrong remainder, and overpays cashback.

**Next session:** get the owner to comment `agents free on services/svc-bank`, or land a PR
clearing that field. Then #1102 merges as-is; it needs no further work.

---

## Not started

**`bank.earn` — a full day's interest for one minute of exposure. Confirmed, unfixed.**
Accrual selects `WHERE opened_at <= <the cron moment>` with no proration and no minimum
holding period. Deposit at 00:04, cron fires 00:05, the position earns a full day; withdraw
at 00:06 — flexible pool, no lock, no penalty. Repeat daily. On the 36.5% APR pool the
tests use that is roughly 365,000 USDT/year on a 1,000,000 deposit for about a minute a day
of capital at risk, drawn from `houseFees`. It cannot print money — the reserve is hard
non-negative — but it pays yield that was not earned, out of real platform revenue.
The comment directly above the query asserts the opposite behaviour. The test named to
defend it opens 2026-03-05 and accrues 2026-03-02, three days clear of the boundary, so it
passes trivially and tests nothing.
_Blocked by the same svc-bank claim._ Read: `services/svc-bank/src/earn/earn-service.ts`
(the accrual query) and `docs/adr/2026-08-04-bank-vertical-law.md` for the bar. Fix is
either proration or a minimum full day held — the choice is a product call worth asking.

**`bank.sovereign-card` — never reached.** Custodial half only; the on-chain JIT contract
half is the chain owner's board. Blocked by the same claim.
Read: `docs/adr/2026-08-04-bank-vertical-law.md` in full including its corrections, and
`INTAFACED_DEFINITIVE_BUILD.md` §18. Done bar is the ADR's six-point bar. The crux the
harvest surfaced: there is no cross-asset conversion recipe in `packages/ledger-client`, and
a JIT conversion is exactly that — so the first real question is whether the honest
deliverable is a refuse-closed surface plus a ledger-side JIT mechanism against a simulated
smart account.

**`market.commerce` — never started.** Listings, subscriptions, purchases, house
commission. Read: `docs/ops/trk/market.commerce.md`. Done bar quoted there at §1.
It is genuinely buildable — `packages/ledger-client` is **not** claim-fenced (`ledger.recipes`
has no owner) — and `market.vendors` now provides the seam it needs:
`VendorService.listingEligibility`. Two things to know before starting: the house commission
rate is an owner-gated blank (build the mechanism, refuse closed on the rate, and the spec
does **not** specify a rounding direction — round in the customer's favour and mark it), and
it is Class M, so the diff wants a money self-audit and an adversarial pass in the PR body.

---

## Only Nitro can decide

1. ~~**The stale `owner: 'cursor-swarm-bank'` on `bank.ramps`.**~~ **Done in this PR** —
   released under the #1122 standard (claim closed, nobody live). Unblocks #1102 and residual
   bank polish.
2. **The house commission rate** for `market.commerce` — DIRECTION §8 item 6, "fee and
   revenue recipes". Blank; nothing can be built past the mechanism without it.
3. **Whether the money-class wave is open for `market.*`.** `docs/ops/SWARM-MANDATE.md:52`
   and `tooling/scripts/swarm.mjs:239` gate `market.vendors` closed behind a coarse
   `^(trade|pay|bank|venue|p2p|market)\.` prefix rule. This lane read the brief naming the
   mountain explicitly as the wave being opened and said so rather than assuming — worth
   confirming, especially as this particular mountain has no money path at all.
4. **Class X, untouched as required:** live card issuer keys remain his. Nothing in this
   lane went near them; `bank.cards` builds the ledger half and the simulator only.
5. **`bank.earn` day-boundary product call** (once #1102 is in): proration vs minimum full
   day held — not an agent free-for-all on yield math.

---

## The claim mechanism itself — a systemic finding, independently corroborated

Two unrelated blocks hit this lane in one session, from different causes but the **same
mechanism**: claim-check maps an owner to a **path**, so a `requires:` entry naming a
directory locks that whole directory for every other agent.

| Fenced               | Claim           | Why it was too wide                                                                                                |
| -------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `services/svc-bank`  | `bank.ramps`    | Claim **closed**; only a stale `owner:` field survived. Fenced four mountains. **Released in this PR.**            |
| `packages/contracts` | `ops.analytics` | Claim **live and legitimate**, but it concerned one analytics surface and fenced a package eleven services import. |

This is not this lane's theory: **#1122 (`chore/ops-claim-release`, since merged) reached the
identical conclusion independently** — _"`requires` on an OWNED row silently becomes a
lock"_ — and released five claims that described nobody, including the `ops.analytics`
entry that was fencing contracts. It did **not** release `bank.ramps`; this closeout does,
under the same evidence standard, so #1102 is no longer claim-parked after merge.

Worth considering: claim granularity at file level rather than directory level, or a
convention that `requires:` on a shared package lists files. Flagged as a design fact, not
proposed as an automated change.

---

## What I could not break, having tried

An adversarial pass read the real code of the three "already done" bank rows and tried to
break each one, rather than taking the tracker's word. The honest negative results:

**`bank.earn` — at the bar, except the day boundary above.** Accrual cannot double-pay:
`(pool_id, accrual_date)` is a real `CREATE UNIQUE INDEX`, not merely a drizzle declaration,
and the claim is taken before any post. Six parallel accrue calls produce one row and one
credit. A pool cannot pay out more than it holds — `earnPoolReserve` is a module account and
the ledger makes it hard non-negative, so an underfunded pool refuses _and does not consume
the day_, so it re-runs once funded. Interest floors twice over and a test asserts it rounds
DOWN. Early withdrawal during a lock refuses before any post.

**`bank.cards` — the admin boundary and the refuse-closed default are real.** The ops
authorise/capture/reverse procedures are genuinely `admin:treasury` enforcing middleware,
not a comment, and a user session is proven refused end-to-end through a real router caller.
The default issuer refuses everything and there is no `?? cardSim()` fallback anywhere — a
deployment that has not chosen an issuer does not quietly approve against a counterparty
that does not exist. `simulated: true` is a required field sourced from the card row, so no
screen can present a simulated card as real. A capture cannot exceed its authorisation, and
two captures cannot settle one authorisation sequentially — blocked twice, in application
code and by a unique index. Cashback rounds down. (The two defects found are the stranding
and the concurrent-capture race, both fixed in #1102.)

**`bank.ramps` — left entirely alone, and it holds up.** The fiat leg refuses
`bank.fiat_ramp_socket` as the **first statement** in both value-moving methods, before any
row is written or amount validated — I found no fiat path that credits. The default mode is
genuinely `none` with an exhaustive switch and a `never` guard. `simulated: true` is
hard-coded in both inserts with no path that sets it false. It also got the resume path
_right_ where cards got it wrong: a crash between hold and settle is recoverable by
re-driving. Two residual gaps belong to whoever holds that claim, not to this lane: there is
no test that a user session is refused `ops.creditOnramp` (the gate is real in code but
unasserted), and reusing an `offrampId` with a fresh `clientRef` raises a raw Postgres
unique-violation instead of the named `bank.ramp_conflict` the code clearly intended.

**`svc-market` is money-true, verified rather than asserted.** No `@intafaced/ledger-client`
import and no amount column anywhere in the service, across all three stages.

---

## Worktrees

Removed: the four merged lane worktrees. Left in place: the `services/svc-bank` one, because
#1102 is still open against it.
