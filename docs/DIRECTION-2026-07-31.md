# Direction — 2026-07-31

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Written for Nitro's agents. **Decisions, not process.** Where I say "decided", implement it and do not re-litigate. Where I say "open", bring me the shape before you build.

Tip when written: `db92837`.

One rule above all of these: **an agent may not decide anything in §8.** Everything else here is now settled and yours to execute.

---

## 1 · Trade engines — order and non-negotiables

### Order — decided

1. **Seed books / mm-bot** (unblocks every trading surface)
2. **Multi-asset instruments** (§2)
3. **Perpetual futures**
4. **OTC desk**
5. **Algo orders (TWAP only)**

**Futures are NOT first, and this is the decision I most want respected.** Spot is real today — matching, holds, venue hours, CCXT contract. Futures is not one feature; it is five, and four of them are things that lose other people's money when wrong: mark price, funding, margin, liquidation, insurance fund. Building it before the book has depth means liquidating positions against a book that cannot absorb them.

### Margin model — decided: **isolated only for v1**

Cross-margin is more capital-efficient and is how a single bad position takes an entire account to zero. **Isolated margin means the blast radius of any liquidation is one position.** Cross is a v2 conversation and needs its own ADR.

Max leverage v1: **10×**. Not a product opinion — it is the number at which our liquidation latency is survivable. Raise it only with evidence from §1's liquidation proof.

### Liquidation posture — decided

- **Partial liquidation before full close.** Close the minimum that restores maintenance margin. Full close is a failure mode, not a policy.
- **Maintenance margin laddered by position size.** A position large relative to book depth is riskier at the same notional; the ladder must reference actual depth, not a constant.
- **Insurance fund must exist and be funded before a single real-money position opens.** Not a socket, not a TODO. If it is empty, futures do not list.
- **ADL is last resort and must be disclosed in-product before a user opens a position.** A user auto-deleveraged without prior disclosure has been treated dishonestly, whatever the docs say.
- **Liquidation is a ledger-client operation like any other** (§0.6). No liquidation path holds its own balance.

### What "MVP done" means for futures — hard spec

Not "orders match". All of these, or it is not done:

1. A position opens, marks against an oracle, and the mark is **not** our own last-trade price.
2. Margin call fires, is delivered, and is observable.
3. **Partial** liquidation executes against a real book and restores maintenance margin.
4. A gap that exceeds the position's margin drives the shortfall into the **insurance fund**, and the fund's balance moves by exactly the shortfall.
5. Proven against a price series **that actually gaps** — not a smooth ramp. A liquidation engine that has only seen continuous prices is untested.
6. Funding accrues, is charged, and nets to zero across longs and shorts.

Any of 1–6 missing → tracker says `ready` or `wip`, never `done`.

### mm-bot / seed books — non-negotiable

Seeded liquidity is allowed. **Seeded liquidity that a user cannot distinguish from real liquidity is not.**

- Every seeded order is **flagged in the data model and in the API response.**
- Seeded volume is **never** counted in any user-facing volume, depth, or "24h" statistic. Those numbers are a claim about other people's willingness to trade.
- The bot is **killable from the kill-switch surface**, like every other route.
- The bot **never trades against a real user order** in a way that manufactures a fill the user would not otherwise have got — if it crosses, it is providing liquidity, and that must be provable from the tape.

### OTC / copy / algo — explicitly out for v1

- **OTC desk v1** = advert, escrow, release, dispute. In scope.
- **Copy trading — SUPERSEDED 2026-08-01. Build the sovereign shape only:** [`SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md). Non-custodial session keys on the follower's own account, capped on-chain, unilaterally revocable, and the leader is paid a **share of our trading fee — never a cut of follower P&L**. The original ban stands for everything outside that spec: **pooled funds, discretionary managers, performance fees, high-water marks and returns-ranked leaderboards remain OUT** and stay in §8.
- **Algo v1 = TWAP only.** Icebergs are OUT: a hidden order that leaks through matching-engine timing is worse than no hidden order, and proving it doesn't leak is its own project.

---

## 2 · Multi-asset instruments

### Product law — decided

An instrument declares: `asset_class`, quote convention, tick, lot, settlement, and trading schedule. That is the whole model; resist adding per-class special cases into the engine.

**Forex and commodities do not list in production until fiat settlement rails exist.** The instrument model and venue-hours enforcement can and should land first — they are honest on their own. Listing a forex pair we cannot settle is the lie; modelling one is not.

### Resume vs greenfield — decided: **resume `feat/multi-asset-instruments`**

Three commits, and the work is sound: the instrument model, closed-venue refusal, and a real test-database fix. Rebase onto tip. Do **not** greenfield — `assertMarketOpen` already landed separately in #102, so a greenfield rewrite would re-derive it and conflict.

**Merge bar:** the instrument model must be **additive** — every existing spot market must behave identically before and after, proven by the existing spot suite passing unchanged. A schedule enum added without a `TRADING_SCHEDULES` entry must **refuse**, not throw.

---

## 3 · Money rails go-live posture

Live crypto is on main (#226). What remains, in order:

1. **Durable broadcast.** A broadcast that does not survive process death is an at-most-once promise about money. Until a signed transaction is persisted before it is broadcast and resumable after a crash, the crypto rail is dev-grade regardless of it working.
2. **Merchant onboarding.** `pay:write` is withheld with **no granting mechanism at all** — so the entire merchant surface is unreachable in production today. The gate is KYB tier. **Mine to decide, not agent-inventable.**
3. **Card.** Blocked on a sponsor bank / acquiring BIN. Commercial, not code. Do not scaffold a card-capture UI — it drags PCI scope in with it.

### Class M merge rule — decided

**Your agents may merge Class M on green + self-audit + adversarial review**, with four carve-outs that stay mine:

- anything that **moves value to an external counterparty**
- anything that **grants or widens a scope**
- anything that **adds or changes a ledger recipe**
- anything that **touches a posture gate, kill-switch, or custody scan**

Those four are not about trust — they are the places where a mistake is silent and reconciliation finds it days later. Everything else in Class M: ship it.

---

## 4 · Dual-book / balance ownership — **DECIDED. Option B.**

This has been open since 28 July with eleven documents blocked behind it. Deciding it now.

**`ledger.*` is the only book. There is no second book to reconcile.**

Rationale, and it is not a preference: the audit measured the vendored side — `member` 0 rows, `member_wallet` 0 rows, `exchange_order` 0 rows. **Nobody has ever registered.** Option C's entire premise is that the vendored side holds a book worth preserving. It does not hold anything.

### The rule agents implement

- `member_wallet` becomes a **read-only projection** of `ledger.*`. Nothing in Java writes it, ever.
- The **25 money controllers are disabled at the door** — not rewritten in place, not left reachable-but-unused. A controller that can still be called is still a second book.
- The four `MemberWalletDao` mutators (`increaseBalance`, `decreaseBalance`, `freezeBalance`, `thawBalance`) become **hard-banned by scan**, not by convention.

### Two enforcement gaps that must close with it

- **`custody-scan` walks `.ts`/`.tsx` only — it has never read a line of Java.** Fix it, or this decision is unenforced.
- **`vendor-shell-scan` bans seven exotic mint patterns while permitting the four mutators every money controller actually calls.** Invert that.

Mark the ADR **`Status: Accepted`** and close the eleven dependents.

---

## 5 · Protocol plane

### The bar — decided

**A dev chain deploy is not `done`.** Anvil regenerates at genesis; every address is deterministic because nothing persisted. Proof against it is proof of derivation, not of deployment.

`done` for anything on-chain requires **all** of:

1. deployed to a **persistent public testnet**,
2. **verified source** at that address,
3. the address **recorded in-repo**,
4. the **CREATE2 cross-check re-run against that chain's factory** — not anvil's.

That last one matters more than it reads: the derivation is only correct per-chain if the factory bytecode is identical there. **Assume nothing carries over from anvil.**

### Factory truth

The predicted address must be cross-checked against the deployed factory **on every chain we claim to support**. One passing chain is one chain.

### What not to mark done — hard list

- anything proven only against a chain that regenerates at genesis
- anything unaudited (`launch.status` returns `audited: false` — that is honest, keep it)
- **prod RPC provider and signing-key custody — mine, §8**
- `protocol.amm` — the compile unblock landed, but a pool that compiles is not a pool with reserves, invariant tests, or an oracle-manipulation review

---

## 6 · Spine crash WIP — one line each

**CURRENT (2026-08-15):** [`ops/SPINE-BRANCH-DISPOSITION-2026-08-15.md`](ops/SPINE-BRANCH-DISPOSITION-2026-08-15.md) — re-derived from `git ls-remote` / `gh` against origin. **Resume count: 0.** Table below is historical (written 2026-07-31).

| branch                                                                                                                                                        | call                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/multi-asset-instruments`                                                                                                                                | **RESUME** — real work, rebase on tip, see §2                                                                                                                                               |
| `feat/spine-market-seeder`                                                                                                                                    | **RESUME, priority** — includes a MongoDB driver pin; the vendored stack is dead right now on exactly this (`mongo:6` removed `OP_QUERY`, the Spring Boot 1.5.9 driver speaks nothing else) |
| `feat/spine-java-custody`                                                                                                                                     | **RESUME** — closes three custody holes in the forked Java exchange; directly serves §4                                                                                                     |
| `feat/spine-screening-guard`                                                                                                                                  | **RESUME** — an unconfigured sanctions blocklist that fails loudly is straightforwardly right                                                                                               |
| `feat/spine-venue-fabric`                                                                                                                                     | **ABANDON** — superseded, #209 landed                                                                                                                                                       |
| `feat/spine-derivatives`                                                                                                                                      | **REWRITE** — single crash-WIP commit, and §1 changes the design under it                                                                                                                   |
| `feat/spine-otc-desk`                                                                                                                                         | **REWRITE** — single crash-WIP commit; rebuild against §1's v1 scope                                                                                                                        |
| `feat/spine-amm-reserves`                                                                                                                                     | **REWRITE** — two crash-WIP commits, written while the pool could not compile at all                                                                                                        |
| `feat/spine-bank-card`                                                                                                                                        | **ABANDON** — §3 blocks card on a sponsor bank; nothing to build yet                                                                                                                        |
| `feat/spine-agent-fleet`, `spine-academy-launch`, `spine-dex-quotes`, `spine-dod-gate`, `spine-scope-issuance`, `spine-java-rename`, `spine-market-stability` | **TRIAGE, low priority** — one commit each, 2 days stale. Read, salvage anything cheap, delete the rest. Do not resume on principle.                                                        |

**None of these are protected. Force-push or delete any of them freely — I am not holding state in them.**

---

## 7 · Bank / Phase 5 — decided

**Honesty-only on existing mounts first.** A mounted surface that overstates what it does is a worse liability than a missing one, and we have more mounts than we have rails.

Priority after that: **ramps → earn → cards.**

- **Ramps** first because they are the only one that makes every other balance non-zero.
- **Earn** second, and with a hard constraint: **yield must have a named source.** "Earn" that pays from treasury is not yield, it is marketing spend, and it must not be described as yield anywhere in-product.
- **Cards** last — blocked on the same sponsor-bank conversation as §3.

---

## 8 · Mine alone — agents must not decide these

Bring me the shape; do not invent it.

1. **Go-live** on any rail, and anything described as production-ready
2. **Secrets** — rotation, custody, and the disclosed actuator password still in git history
3. **Prod RPC** provider and **signing-key custody**
4. **Scope granting** — including the KYB gate behind `pay:write`
5. **Listing policy** — which assets list, and delisting
6. **Fee and revenue recipes** — every one is a §0.6 ledger recipe
7. **Sanctions blocklist content** — needs counsel, not engineering
8. **Leverage, margin and liquidation parameters** beyond §1's stated defaults
9. **Anything described to a user as audited, insured, or guaranteed**
10. **`leader_share_bps` and every other fee-share rate**, plus any copy surface beyond the sovereign spec — pooling, discretion, P&L-linked fees, ranking. The sovereign shape itself is now specced and buildable; the **rates** and the **jurisdiction list** are not.

---

## Standing notes for agents

- **Failures cluster by time window, not by branch.** Before chasing a red in a service you did not touch: rebase, `pnpm --filter @intafaced/db build` (a stale dist fakes `assertTestDatabase is not a function`), then stash your diff and re-run to prove ownership.
- **Commit and push early.** A crash corrupted a branch ref to 41 NUL bytes this week; only committed work survived.
- **`format:check` is step one of `verify`**, so one unformatted markdown file blocks every gate behind it. It has taken main red three times, and CI's docs `paths-ignore` means CI never catches it. Worth fixing structurally.
- **`ConstantProductPool` compiles now**, but see §5 — compiling is not shipping.
