# Owner decision packet — Denon product law (not a Nitro waiting room)

**Written by:** Denon, 2026-08-09. **Law correction 2026-08-14:** this file does **not** park engines on a Nitro click. Durable ownership already gives **Denon** direction on rates, house desk, venue set, and futures/OTC/copy/algo product law. **Nitro is Class X only** (secrets, prod go-live, licence, sanctions **list content**). Recommendations in this packet are **taken by Denon** unless the JSON row is `class_x`. Q1 remains **external-only for v1**.  
**Tip at last completeness pass:** `93f6c777` (2026-08-12).  
**Board:** `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` **D26-P0-01…18**.  
**Tip packet family (D26-P0-18 sealed as tracker):**

| Layer         | Path                                                                                           | Role                                                       |
| ------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| This file     | `docs/OWNER-DECISION-PACKET-2026-08-09.md`                                                     | Human sitting — P0-01…03 + money-path / dark-feed / F10    |
| Part two      | [`OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md`](OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md) | Human sitting — P0-04…17 shapes                            |
| Machine index | [`ops/owner-ruling-packet.json`](ops/owner-ruling-packet.json)                                 | **SoT for open/sealed/class_x** — every owner decision row |

**Originally (2026-08-09, WRONG):** the packet author treated every item as waiting on Nitro. That rule is withdrawn. **Update 2026-08-12:** §A1 (house desk / internal MM) is **sealed** as Accepted owner rulings in the fairness ADR (D26-P0-01). **Update 2026-08-12 (P0-18):** part two filled + JSON index. **Update 2026-08-12 (P0-15):** copy **jurisdiction list** mechanism is **sealed refuse-closed**. **Update 2026-08-14:** Denon executes his own recommendations; do not invent a second wait-on-Nitro gate.

**One rule I have applied throughout:** where a number is missing, the answer is **not** a placeholder. `services/svc-trade/src/copy/` already does this correctly — it is **refuse-closed** with `COPY_FEE_SHARE_RESIDUAL`, declining the surface and naming the residual rather than inventing a rate. That pattern is the model for item 3 below.

---

## First — one item is already decided and nobody noticed

**`DEFAULT_MAX_LEVERAGE = '10'` needs no ruling.**

`19340c9e` shipped it labelled _"placeholder awaiting a `DIRECTION` §8 item 8 ruling."_ But §8 item 8 reserves _"leverage, margin and liquidation parameters **beyond §1's stated defaults**"_ — and [`DIRECTION-2026-07-31.md:27`](DIRECTION-2026-07-31.md) states:

> **Max leverage v1: 10×.** Not a product opinion — it is the number at which our liquidation latency is survivable. Raise it only with evidence from §1's liquidation proof.

The agent picked `10` independently and matched the standing decision. **This is not open.** I am removing it from the list rather than asking you to re-rule it, and the constant's comment should be corrected to cite §1 instead of claiming it awaits §8.

**Consequence worth stating:** §1 conditions raising it on _"evidence from §1's liquidation proof."_ That proof does not exist — there is no margin call, no grace and no partial liquidation in futures today (see item 7). So 10× is not merely the current number, it is **the ceiling until the liquidation ladder exists.**

---

# A · The three that unblock whole engines

## 1 · House desk and internal market making — three questions

**Status:** **SEALED 2026-08-12 (D26-P0-01).** Recommendations below are now **Accepted owner rulings** in [`adr/2026-08-08-house-desk-and-market-making-fairness.md`](adr/2026-08-08-house-desk-and-market-making-fairness.md). Tracker notes for `execution.house-tenant` / `execution.market-making` flipped to external-only path vs still-blocked internal.
**Still blocked after seal:** `execution.house-tenant` on our own venue; internal half of `execution.market-making`.
**Unblocked for engineering:** `execution.sor`, `execution.arbitrage`, external half of `execution.market-making` (still subject to their other deps).

§28 says three things that compose badly: the house desk is **sealed and undisclosed** (`:777`), it has **"structural first-class access"** to the venue we own (`:774`), and its MM engine **"seeds our books and works the street"** (`:773`). Together: a sealed desk quoting both sides of the book we settle customer fills against — sitting on top of _"a price that moves money is never supplied by the party it pays."_

### Q1 — Does the house desk trade our own venue, or only external ones?

**Accepted ruling: external-only for v1.** SOR, arbitrage, the cost model and execution reports may be built and proven against external venues with no fairness surface. Internal house-on-own-venue stays blocked until a later explicit ruling.

### Q2 — If it trades our venue, is its _existence_ disclosed?

**Deferred.** Existence-disclosure is not decided because internal trading is off for v1. A later ruling that permits internal trading must answer this before that half ships. (Background: Throne Law is unambiguous about **strategies** and silent about **existence**; honesty doctrine points at disclosure — still a positioning call when/if internal is reopened.)

### Q3 — Where is the line between "seeding" and "supplying a price that moves money"?

**Accepted ruling: HARD EXCLUSION** — internal quotes never counted in mark derivation. No percentage cap invent (ties `DEFAULT_MIN_BEST_LEVEL` / dust refuse path; item 4's unruled numbers stay separate).

---

## 2 · The dex venue set — one sentence

**Status:** **SEALED 2026-08-13 (D26-P0-03)** — [`adr/2026-08-13-dex-venue-set-refuse-closed.md`](adr/2026-08-13-dex-venue-set-refuse-closed.md).  
**Blocks:** `dex.quote` reaching `done`; `socket.dex-venue-set` still a socket until a **host** publishes `DEX_EXTERNAL_VENUES` (credentials / Class X), not a Nitro product-law click.  
**Ruling:** shipped default is empty; empty is `dex.quote.no_venue_available`. Agents do not seed `DEX_EXTERNAL_VENUES` or name a partner in git. One reachable row already proves the path; that is not a licence to commit it.

The code is finished. It cannot serve a quote on shipped defaults. That is honest until a host publishes a set. Do not invent the venue in an ADR.

---

## 3 · The §8 rate, fee and share numbers — and the mechanism

**Blocks:** `trade.copy` payout, market commission, affiliate rates, and any pay fee table still carrying a seed.

**The mechanism question is Denon’s and is answered: refuse-closed when unset.** Magnitudes that later ADRs publish are Denon product law. Remaining unpublished tables stay refuse-closed — they do **not** wait on a Nitro product-law click. Sanctions **list content** stays Class X.

**Ruling I am making (mechanism only):** a surface whose rate is unset is **refuse-closed and says so** — it does not fall back to a source seed, a zero, or a "sensible default." `services/svc-trade/src/copy/` already implements exactly this:

```
COPY_FEE_SHARE_RESIDUAL =
  'DIRECTION §8 leader_share_bps is owner-only — refuse-closed (never invent fee-share rates)'
```

That is the pattern. **A seeded rate in source is indistinguishable from a decided one three months later**, which is how an invented bps becomes policy nobody chose.

**Taken 2026-08-14 (and 2026-08-13 ADR where sealed):** each is a published number **or** explicit launch-closed. Agents never invent a missing one:

| Parameter                  | Surface it gates                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leader_share_bps`         | copy trading payout                                                                                                                                                                   |
| Copy **jurisdiction list** | **SEALED refuse-closed (D26-P0-15)** — which regions may copy; never invent; [`adr/2026-08-12-copy-jurisdiction-refuse-closed.md`](adr/2026-08-12-copy-jurisdiction-refuse-closed.md) |
| Market commission rate     | `market.commerce`                                                                                                                                                                     |
| Affiliate commission tiers | `ops.affiliates`                                                                                                                                                                      |
| Pay fee table              | PSP pricing surfaces                                                                                                                                                                  |

**Recommendation: publish them into a config authority, not source.** Set what you know, leave the rest launch-closed. A launch-closed surface that says why is honest; a surface running on a placeholder is not. **Copy jurisdictions:** mechanism sealed refuse-closed; you still own the eventual allowlist content via `TRADE_COPY_JURISDICTION_LAW`.

---

# B · Money-path parameters

## 4 · Two depth numbers on the futures mark path

Both landed in `19340c9e` as placeholders, and unlike the leverage cap **these genuinely are §8 item 8** — they gate whether a mark may liquidate.

- **`DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '100'`** — absolute floor, quote units per best level.
- **`DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL = 100`** (1%) — the best level must also carry this fraction of the position it is pricing.

The relative one exists because the absolute one alone was exploited: **two orders worth ~120 quote units priced the close of a 1,000,000 notional position and extracted 190,000 USDT.** Raising the absolute number does not fix that — it moves the size at which the same arithmetic works and makes ordinary markets unquotable on the way past.

**Recommendation: keep both at the shipped values until a market is actually listed with real depth**, then set them from observed book data rather than from judgement. I have no evidence for a better number and neither does anyone else yet.

## 5 · Which account funds realised futures profit

Open since [`adr/2026-08-05`](adr/2026-08-05-futures-risk-and-mark-law.md). **PKT-B5 seal (2026-08-15):** `TRADE_FUTURES_PROFIT_SOURCE` remains unset. `futuresRealizeProfit` stays refuse-closed until the owner names the account. No silent `houseFees` fallback; no house account invented. Compose still has **no default**. That is Denon law, not a Nitro click.

## 6 · Turning funding on for a market

Explicitly owner-reserved by the same ADR. Nothing is blocked _today_ because `TRADE_FUTURES_JOBS_ENABLED` ships off — but note §7: that flag being off is also what freezes every position's mark basis.

---

# C · Postures and horizons

## 7 · The dark-feed horizon, and operator settlement of a frozen position

From [`adr/2026-08-07`](adr/2026-08-07-futures-exit-when-the-feed-is-dark.md):

- **How long may a market sit dark before frozen positions become an operator alert?** A posture parameter.
- **May an operator ever settle a frozen position at an adjudicated price if a feed never returns?** External value movement, `DIRECTION` §3. **Until decided the answer is no** — and today that means a position frozen past the deviation breaker has **four exits and all four are shut.**

**Recommendation on the second:** yes, with two conditions — a human adjudicates (never a job), and the adjudicated price and its author are recorded on the row. The alternative is collateral that is permanently unreachable, and [`adr/2026-08-07`](adr/2026-08-07-futures-exit-when-the-feed-is-dark.md) already ruled that **a control which traps funds is not a safety control.**

## 8 · The `p2p:moderate` scope split

**Taken (PKT-C8 / 2026-08-14):** do not mint `p2p:moderate`. Allowlist + `admin:compliance`. Who is on the list is Class X.

## 9 · Four token numbers

Emission, buyback, burn and staking parameters. [`adr/2026-08-04-token-economics-outcomes.md`](adr/2026-08-04-token-economics-outcomes.md) decided **whose they are** and deliberately decided **no number**.

---

# D · Two live defects that need an owner action, not a fix

## 10 · `act/pom.xml` declares `rpc-common` twice — F10, LIVE

`vendor/upstream-exchange/01_wallet_rpc/act/pom.xml` declares `rpc-common` at version `1.0` and again at `1.2`. **Maven resolves the first.** `1.2` is where the auth guard lives; `1.0` does not exist in this reactor. Resolved from a stale local repository, **`act` boots serving `/rpc/**` to anyone who can open a socket, and throws nothing at startup** because nothing else reads `rpc.auth-token`.

Recorded as **F10 LIVE** in the 2026-08-05 security review, and **frozen — not fixed** — in `wallet-rpc-auth-scan`, where `act` is the sole `RECORDED UNPROVEN` module. Remediation is `OWNER-ACTIONS-WALLET-RPC-SECRETS.md` **§A4** because the edit is inside unreviewed, never-compiled, key-handling third-party code. **I have not touched it and will not.**

## 11 · `svc-bank` earn and loans idempotency — **WITHDRAWN 2026-08-09. Already fixed; nothing is needed from you.**

**This item was wrong and I am correcting it rather than quietly deleting it.**

It claimed the earn and loans idempotency defects were live on `main` with a written fix stranded behind an owner lock on `services/svc-bank`, and asked you to release the lock or direct the lane owner. **Both defects were already closed** by `5ff7f8ba` — _"fix(bank): compare terms before treating a taken earn/loan id as a retry"_ (#1194).

Verified in the current source, by the patch’s own symbol names:

- `services/svc-bank/src/earn/earn-service.ts:275` calls **`reuseOrRefuse(positionId, input.userId, pool.id, input.amount)`** — so a taken id is compared against user, pool and amount instead of silently no-opping.
- `services/svc-bank/src/loans/loan-service.ts:519` checks **`loan.userId !== input.userId || loan.productId !== product.id`** and throws **`bank.loan_borrower_mismatch`** — the borrower is checked, not only the amount.

**The claim lock worked exactly as designed.** I declined to dual-edit a claimed money service, the lane owner took the patch, and it landed. The mechanism did its job; my reading of it was stale.

**What I got wrong, precisely:** I treated a parking note as current state. Three documents on `main` described the patch as parked, and I cited them instead of reading the code they were about. A parking note records a moment, not a condition — and this repo has already produced that failure in another form, where a stale board flipped two **CLOSED** items back to open against working code.

**One thing this does not withdraw.** `bank.earn` still reads `status: 'done'` in `features.mjs`. That was false while the defect was live, and nothing about the fix landing makes the earlier claim honest in retrospect. Whether the row now genuinely meets the three-part `done` bar (REACHABLE, TESTED, NOT PROPPED UP) is worth re-checking on its own terms — but it is a tracker question for the lane owner, not a decision for you.

# What is decided — engines move

**§A1 / Q1 is sealed (2026-08-12) and taken.** External-only for v1: `execution.sor`, `execution.arbitrage` and the external half of `execution.market-making` are ordinary engineering. Internal house + internal MM half stay blocked until a later **Denon** ruling, not a Nitro click.

**Item 11 is withdrawn** — it was already fixed by #1194 before I wrote it up.

**Item 2 (dex venue set)** is sealed refuse-closed on empty `DEX_EXTERNAL_VENUES` (`adr/2026-08-13-dex-venue-set-refuse-closed.md`). Publishing live venue credentials is host/Class X, not a product-law gate on this packet.

**Still Class X (Nitro human):** secrets, prod go-live, licence, sanctions list **content**, F10 wallet-rpc in unreviewed third-party code (item 10). Token **magnitudes** stay unpublished (item 9 / PKT-C9).

**Do not invent a wait-on-Nitro rule.** If a Denon mountain is stopped, it is because the implementer stopped.
