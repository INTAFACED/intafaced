# Peace of mind — current floor (Nitro)

**Date:** 2026-07-31 (money-class mega on #226–#250)  
**Main tip (literal):** see **TIP block** (authority is `git rev-parse origin/main` after this PR merges)  
**Cook SINCE baseline:** `8a8c19bc626e6dada49a33be1f88d17873f42502` (#107)  
**Prior mega archives:** [`audit/2026-07-30-afk-cook-mega/`](audit/2026-07-30-afk-cook-mega/) · [`audit/2026-07-30-mega-r2/`](audit/2026-07-30-mega-r2/)  
**This money-class archive:** [`audit/2026-07-31-money-class-mega/`](audit/2026-07-31-money-class-mega/)  
**Claim tags:** `[VERIFIED 2026-07-31]` money-class mega · L0 local green · **not go-live** · **multi-replica journal on tip (#266); send→put P1 residual**

**Stream A:** [NITRO-STREAM-A-CLAIM.md](NITRO-STREAM-A-CLAIM.md) · uiproof PROOF **UNVERIFIED** this tip

---

## Verdict (one breath)

**PASS-WITH-RESIDUALS.** Money-class deep pass on #226–#228 + #244/#246: doctrine/auth/honesty hold; live EVM rail does **not** book outside ledger-client; posture fail-closed. **Class M residual (updated):** multi-replica journal **CLOSED** (#266 + re-verify). Remaining: send→put crash window **P1**; dust policy M226-04 product. Local doctrine/build/typecheck/test/gate green; money PG + anvil suites skipped. **Not go-live. Not product bug-free. Audit exit ≠ go-live.**

After each Denon wave: [`WAVE-AUDIT.md`](WAVE-AUDIT.md) only — not a full re-audit.

---

## Scoreboard

| System                   | Risk now                                               | Status                                               |
| ------------------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| Ledger                   | Low if perimeter holds                                 | OK to build · PG suites skipped locally              |
| Identity                 | ifc\_ exchange + soft revoke on tip                    | OK                                                   |
| Pay                      | Links + checkout; live EVM #226 + durable journal #266 | OK multi-replica journal · **send→put P1 residual**  |
| Token / bank earn        | Yield/buyback gated; bank PG skip                      | OK · residual                                        |
| P2P                      | Prior fixes; PG suite skip                             | OK · residual                                        |
| Edge                     | ifc\_ + region HMAC; preservePath                      | OK for dev                                           |
| Trade                    | Private REST + convert; R5/R6 holds                    | OK · market-sell cost honest (#244)                  |
| Protocol / DEX / indexer | Mounted shells; chain propped                          | Not product-complete                                 |
| Deploy                   | Fleet + notify + WS JWT                                | Usable with care                                     |
| **Vendor (shell)**       | **UI OK; high if used as books**                       | **UI shell · quarantined as ledger**                 |
| Terminal                 | apps/web equity wired to /account/balance (#228)       | OK honesty · dual-book labeled                       |
| CI doctrine              | Brand/custody/migrate local green                      | OK local · Actions SUCCESS on recent tips (re-check) |

---

## Closed on main (do not re-open without regression)

**#176 mega AFK cook fixes**

- Brand scrub on plan overlay
- trade `0002_display_name_backfill` (M1)
- format green
- `subAccountId` fail-closed
- market buy cost via protectionPrice
- svc-ws compose JWT
- free-mountains scoreboard fossils

**#177** PEACE literal tip SHA after #176

**r2 (this program)** terminal equity honesty copy (balance REST exists; panel not wired)

**Earlier:** #80 · #81 · #86 · #96 · #99 · #101 · #102 · #105 · Proper Track 1 · cook #110–#174

---

## Still open (honest residuals)

| Item                                                   | Verdict                                                      | Who                        |
| ------------------------------------------------------ | ------------------------------------------------------------ | -------------------------- |
| Money e2e / PG suites local                            | **SKIPPED** this host — named in money-class `01-L0.md`      | Human install or CI        |
| OHLCV / futures positions product                      | **HOLDS** honest empty (WS path #227 ready-empty)            | Product                    |
| Factory / chain deploy                                 | **HOLDS** honesty; not product-complete                      | **Denon**                  |
| Live EVM rail **multi-replica**                        | **CLOSED** #266 PostgresBroadcastStore (M226-01 re-verify)   | residual send→put P1 only  |
| Live EVM rail crash send→put (any process)             | **P1 residual** — irreversible if hit                        | Denon + pilot ops          |
| Live EVM refund chain idempotency key                  | **CLOSED** durable refundId passed to rail (M226-02)         | residual-pay close PR      |
| Live EVM first-tx-wins dust                            | **P1 product** (M226-04)                                     | Denon product              |
| Watcher mark-before-webhook-2xx                        | **P2** (M226-03 critic downgrade)                            | agent later                |
| Market sell CCXT `cost` honest null without fills      | **CLOSED** #244                                              | done                       |
| Sub-account ownership S2S                              | **CLOSED** #246 — re-verified money-class 03A                | done                       |
| Live EVM path doctrine (ledger-only, decimal, posture) | **HOLDS** code-reviewed money-class 03B                      | residual ops keys/RPC only |
| Stream A PROOF / Chromium                              | **UNVERIFIED**                                               | Nitro desktop              |
| Terminal equity **UI wire**                            | **CLOSED** #228 — re-verified 03C                            | done                       |
| AMM compile honesty                                    | **CLOSED** artefacts compile; factory still 0x0 until deploy | deploy residual Denon      |
| Licences · wallet secrets · counsel · kill drill       | human/ops/law                                                | Denon + you                |
| Dual-book **policy ADR**                               | still human — UI labels do not close policy                  | owner                      |

---

## Explicit non-problems

- Cook money/auth/migrate agent P0s from prior mega — closed and re-verified HOLDS
- Doctrine scans local green
- Tracker convert/links/notify mounts match notes

---

## TIP block (literal)

```
SINCE (cook baseline):              8a8c19bc626e6dada49a33be1f88d17873f42502
PRIOR residual WAVE product high:   cd277dcc3fc2f71d3694b2eccc12b20d0fdb3f00  (#239)
MONEY-CLASS PRE-AUDIT TIP:          4b77c173cd04c1d347da53cefaecb0c8fdd42c0c  (#250)
FINAL main tip (authority):         set to origin/main after this money-class PR merges
```

**Authority is always `git rev-parse origin/main` after the last audit merge.**

Archive proof: `docs/audit/2026-07-31-money-class-mega/` (`01-L0` … `04-ADVERSARIAL` · `WAVE-AUDIT-RESULT`).

---

## Money-class mega (2026-07-31)

**Method:** [`WAVE-AUDIT.md`](WAVE-AUDIT.md) mega depth · archive [`audit/2026-07-31-money-class-mega/`](audit/2026-07-31-money-class-mega/)  
**Verdict:** **PASS-WITH-RESIDUALS** · critic on M226-01…04 in `04-ADVERSARIAL.md`

```
PRE-AUDIT TIP:     4b77c173cd04c1d347da53cefaecb0c8fdd42c0c
PRODUCT THROUGH:   #226 live rail · #227 positions · #228 AMM+equity · #244 cost · #246 S2S · residual Stream A
L0:                brand/custody/vendor-shell/db/tracker/format/build/typecheck/test/gate PASS (PG money suites skipped)
CLASS M HOLD:      multi-replica live rail until durable BroadcastStore
STREAM A PROOF:    still UNVERIFIED
SECRETS / ADR:     still human/owner
```

---

## High water (backend audit fire — 2026-07-31 continued)

**Tip at write:** `656d47a66a8d8b45099782c40fcd49430650bb11` · always re-check `git rev-parse origin/main`.

| PR   | What                                            |
| ---- | ----------------------------------------------- |
| #251 | Money-class mega archive on #226–#250           |
| #252 | Denon #201–#218 deep + bank B-01 + pay M226-03  |
| #253 | bank.loan_liquidating error code                |
| #254 | P2P InsufficientFunds rehydrate                 |
| #255 | Shared rehydrate for all service ledger clients |

**Backend only.** Frontend / Stream A other chat. Multi-replica pay journal **CLOSED** #266 (send→put P1 remains). Token buyback product residual (T-01/T-02). Not go-live.

---

## Mega finish close (2026-07-31)

**Verdict:** **COMPLETE-WITH-HOLDS** · archive [`audit/2026-07-31-mega-finish/`](audit/2026-07-31-mega-finish/)  
**Not go-live.** Local money PG e2e blocked (no Docker/Postgres on audit host).  
**ID-P1-1 recovery codes:** hashed store + redeem on login (#275 + #277).  
**M226-01:** **#266 merged** + re-verify residual-pay close — multi-replica CLOSED.  
**Dual-book ADR:** Denon **#272** Accepted on main.  
**Tip authority:** `git rev-parse origin/main` after merge.

---

## Residual-pay close (M226-01 re-verify + M226-02) · 2026-07-31

**Honesty:** finish set was COMPLETE-WITH-HOLDS; M226-01 re-verify was deferred too long after #266 — closed here.  
**M226-01:** PostgresBroadcastStore on live boot — multi-replica P0 **CLOSED**; send→put window **P1**.  
**M226-02:** durable `refundId` into `RailAdapter.refund` / crypto-native chain key — **FIXED**.  
**Archive note:** [`audit/2026-07-31-mega-finish/07-POST-FINISH-HONESTY.md`](audit/2026-07-31-mega-finish/07-POST-FINISH-HONESTY.md)  
**Not go-live.**
