# SPEC — Mega backend plan (everything except frontend)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Execution contract for this chat after Nitro says **go**. Not a second north-star.  
**Date:** 3 September 2026  
**Tip this stamp:** `origin/main` `de0a9cb4b` (re-fetch every card). Grok door is diverged — ignore it.  
**Grokbot:** paused, will not be used. **This owner** ships backend. Codex owns all frontend.  
**Audience:** builders after **go**. Nitro does not brief and does not decide engineering.

Companions: v1.24 harden [`SPEC-PRO-EXCHANGE-HARDEN-AND-REMAINDER-2026-09-03.md`](SPEC-PRO-EXCHANGE-HARDEN-AND-REMAINDER-2026-09-03.md) on [#3777](https://github.com/Phantom-X-007/intafaced/pull/3777); v1.23 inventory on [#3708](https://github.com/Phantom-X-007/intafaced/pull/3708). Merge those in Wave 0.

---

## 0. What “mega” means here

Mega is **complete remaining non-frontend work**, not a longer refuse mill.

| Layer                      | In this plan                                                                                                                                                                   | Not this plan                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **H — Harden**             | Prove grokbot claims that are unit/JUnit/skip-green (FIX compose, L3 door, SBE Java, PG money, combo match, JobHost, QuantLib consumer, surveillance journal, basket→matching) | Another GET-exists refuse                                    |
| **R — Exchange remainder** | Named leftover cards (RFQ, four-eyes, exercise jobs, copy/agentic/FX/quant refuses)                                                                                            | Recook M00–M28                                               |
| **Q — Other backend**      | Protocol, pay/bank rails, token, DEX invented bps, mining payout JobHost, edge, notify-dark, agents denylist                                                                   | Vue, charts, TradingView, `05_Web_Front`, `packages/ui`, M07 |
| **Human-only**             | Named and left refuse                                                                                                                                                          | Inventing fees/legal/lists                                   |

**Done after go (software):** every HARDEN card has a compose or HTTP/FIX/JobHost door; money tests red without Postgres; no invented compose bps; leftover products are live-path refuse.  
**Still not a live venue:** no makers, no licensed entity, no fee schedule — those stay closed on purpose.

---

## 1. Out of scope (Codex / other agent)

`vendor/upstream-exchange/05_Web_Front` · M07 · TradingView / advanced charts · `packages/ui` · Vue cmd-palette/tickets/layouts · frontend test PRs. If a card needs a UI, ship the **backend contract** only.

Shehzad protocol Solidity audit **firm pay** is OWNER. Merging engineering-ready `#3746` is AGENT-NOW (Wave Q).

---

## 2. Human-only (the only real Nitro blockers)

Blank env → named refuse. Never git-default a number. Never ping.

| #   | Plain                           | Env / socket                                               | Refuse                           |
| --- | ------------------------------- | ---------------------------------------------------------- | -------------------------------- |
| 1   | Who may be served (countries)   | counsel lists; copy `TRADE_COPY_JURISDICTION_LAW`          | follow closed; do not draft ISO  |
| 2   | Sanctions **list content**      | `INTAFACED_SANCTIONS_*`                                    | never author the list            |
| 3   | Licensed entity / “we’re legal” | Class X licence                                            | no public-money claim            |
| 4   | Fee table                       | `TRADE_FEE_SCHEDULE`                                       | `trade.fee_schedule_blank`       |
| 5   | Convert / slippage bps          | `TRADE_CONVERT_SPREAD_BPS` `TRADE_MARKET_SLIPPAGE_CAP_BPS` | unset refuse; **no 10/200**      |
| 6   | Offramp wait hours              | `BANK_OFFRAMP_COOLING_HOURS`                               | `bank.offramp_cooling_unset`     |
| 7   | Rulebook version / “certified”  | `MATCHING_RULEBOOK_VERSION`                                | unpublished                      |
| 8   | FIX customer map                | `FIX_COMPID_ACCOUNT_JSON`                                  | `matching_account_unmapped`      |
| 9   | DMA tree                        | `IDENTITY_DMA_HIERARCHY_LAW_JSON`                          | DMA refuse                       |
| 10  | Options settlement asset/fixing | `TRADE_OPTIONS_SETTLEMENT_*`                               | listing/job refuse               |
| 11  | Dated futures fixing            | `TRADE_FUTURES_SETTLEMENT_FIXING`                          | listing/job refuse               |
| 12  | ADL size                        | `maxReduceBps`                                             | `trade.adl_unconfigured`         |
| 13  | Haircuts                        | `TRADE_COLLATERAL_HAIRCUT_BPS`                             | `trade.haircut_unset`            |
| 14  | MMP sizes                       | `EXECUTION_MM_MMP_THRESHOLDS`                              | unset-refuse                     |
| 15  | Portfolio-margin scenarios      | owner set                                                  | `trade.portfolio_margin_unset`   |
| 16  | QuantLib “we sell Greeks”       | `INTAFACED_QUANTLIB_NATIVE`                                | unlink refuse                    |
| 17  | Maker rebates / affiliate MM    | §8.9                                                       | unset program does not pay       |
| 18  | Insurance legal / “insured”     | §8.15                                                      | claim refuse                     |
| 19  | Custody partners / off-exchange | §8.11                                                      | product refuse                   |
| 20  | SLOs / RTO / compensation       | §8.13                                                      | measure raw; no invented targets |
| 21  | CompID real customers           | same as 8                                                  | fixtures in tests only           |
| 22  | Notify email/SMS/push creds     | Class X                                                    | in-app only                      |
| 23  | DEX partner venues              | `DEX_EXTERNAL_VENUES`                                      | `dex.quote.no_venue_available`   |
| 24  | Token emission/buyback numbers  | PKT-C9                                                     | unpublished                      |
| 25  | Tax jurisdiction map            | `TAX_JURISDICTION_MAP_JSON`                                | refuse completeness              |
| 26  | Prod host / keys / go-live      | Class X                                                    | paper/dev only                   |
| 27  | PSP / card BIN / Hyperswitch    | Class X                                                    | no Hyperswitch                   |
| 28  | Merchant `pay:*` grantor        | A2                                                         | unpublished grant                |
| 29  | Listing which assets            | P0-06                                                      | empty catalogue                  |
| 30  | CORS prod origins               | `CORS_ALLOWED_ORIGINS`                                     | no `*` invented                  |

**Already sealed — do not re-open:** isolated IM is the live margin product; 10×; house execution **external-only**; copy geo refuse; no second SPA/book.

---

## 3. Agent-closeable (never ask)

Compose `${VAR:-}` empty · Testcontainers or per-branch PG (skip ≠ green) · test CompID fixtures · FIX BeginString 4.2/4.4/5.0 else refuse · L3 from matching queue never L2 · hitch or document extra OMS files · QFJ/SBE/QuantLib pins already chosen · merge `--admin` if Gitleaks green and dep GHSA is trunk-identical; if GitHub still blocks, comment and continue · one service per PR · `pnpm wt`.

---

## 4. Wave 0 — parked PRs (first after go)

| PR                                                            | Action                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [#3777](https://github.com/Phantom-X-007/intafaced/pull/3777) | v1.24 harden spec                                                               |
| [#3708](https://github.com/Phantom-X-007/intafaced/pull/3708) | v1.23 inventory/cards                                                           |
| [#3771](https://github.com/Phantom-X-007/intafaced/pull/3771) | E4 options RFQ refuse                                                           |
| [#3772](https://github.com/Phantom-X-007/intafaced/pull/3772) | A19 four-eyes                                                                   |
| [#3746](https://github.com/Phantom-X-007/intafaced/pull/3746) | protocol audit registry — merge **code**; do not stamp “audited”                |
| [#3707](https://github.com/Phantom-X-007/intafaced/pull/3707) | GHSA — merge if Gitleaks green **or** leave OPS if required-check cannot bypass |

This mega spec PR is Wave 0 as well.

---

## 5. Wave H — exchange harden (substance; first mill)

Prior falsify: **2 of 15** grokbot headline cards are live doors. Treat the rest as **not done**.

| ID  | Service                         | Today                                                                               | Target                                                                                      |
| --- | ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| H1  | `svc-fix`                       | Java acceptor + JUnit; **no compose**; Maven mainClass still stdin `FixAdapterMain` | Compose/`FixAcceptorMain`; NOS → matching POST; unmapped CompID refuses; BeginString refuse |
| H1b | `svc-fix`                       | Drop-copy completeness always refuse                                                | Second session; list included sources honestly                                              |
| H2  | `svc-matching` then `svc-ws`    | `l3Queue()` unit; HTTP depth L2; WS `l3_unavailable`                                | L3 from native queue; never from L2                                                         |
| H3  | `svc-ws`                        | SBE stub utf8; no `INTAFACED_SBE_JAVA`                                              | Real Logic octets in image                                                                  |
| H4  | matching then trade             | Combo can **rest**; no take/fill as one                                             | Match/unwind one instrument; ledger holds                                                   |
| H5  | matching                        | `massQuote()` off router; MMP hardcoded unset                                       | POST mass-quote; magnitudes stay unset-refuse                                               |
| H6  | trade                           | Settlement job hermetic; not on `futures-jobs.ts`                                   | JobHost + PG; blank fixing refuses; never last trade                                        |
| H7  | greeks-adapter then trade/quant | No service consumer                                                                 | One caller; IEEE off wire                                                                   |
| H8  | trade/bank/matching             | Fee/cooling tests skip without PG                                                   | Testcontainers; red without DB; dual-book scan                                              |
| H8c | trade+matching                  | B4 never dispatched                                                                 | Matching 200 then trade death: hold stays                                                   |
| H8e | matching                        | IFM crash FileJournal only                                                          | HTTP crash window; no second rest                                                           |
| H9  | matching                        | Surveillance `Map`; always `detector_gap`                                           | Journal/DB; HTTP list; no auto-fine                                                         |
| H10 | execution                       | Basket HTTP exists; children don’t POST matching                                    | Children → matching; kill-parent unknown ≠ killed                                           |
| H11 | trade/dex compose               | MM seed ±10; `DEX_INTERNAL_BOOK_FEE_BPS:-20`                                        | Blank refuses                                                                               |

OSS: QFJ 3.0.2, SBE 1.39.0, QuantLib 1.43. Never CCXT/CLOB/second book.

---

## 6. Wave R — exchange remainder

After H1 matching POST and H8a exist, or name the residual.

| ID         | Service               | Work                                                                            |
| ---------- | --------------------- | ------------------------------------------------------------------------------- |
| R-A7       | matching              | Compose pass-through empty `MATCHING_RULEBOOK_VERSION` — do not invent a string |
| R-E5       | trade                 | Exercise/assignment/expiry jobs; blank fixing refuse                            |
| R-E6       | trade                 | Delta-hedge unset → refuse; do not start `oms-mmp-hedge.ts`                     |
| R-E7       | trade                 | What-if posts **no money**; missing greeks → refuse numbers                     |
| R-E8       | trade                 | Already SOCKET — do not redo                                                    |
| R-copy     | trade                 | Follow closed all regions; leader ≠ follower money                              |
| R-agentic  | agents/identity/trade | Keep money denylist; install ≠ trading authority                                |
| R-fx       | trade                 | FX products separate; holiday/rail named degrade                                |
| R-quant    | quant/trade           | Paper cannot ledger; live deploy refuse                                         |
| R-security | identity              | Dual-control privileged; “insured” refuse                                       |
| R-onboard  | identity              | Limit/fee-tier change dual-control                                              |
| R-promo    | trade                 | Promotion without budget/end refuse                                             |

Do **not** dual-implement engines already hitched (convert refuse, combo **rest**, isolated IM, STP case, generic OMS slice). **Halt engine** (`halt-law.ts`) already ≡ cancel-only / restart ≠ OPEN — do not write a second halt. Remaining DEPTH is authority/evidence (`PTX-M00-R04`) via R-A7 / G-rulebook, not a new matcher. COD/bulk/TIF: hitch **router** if missing; do not claim ON_MAIN without a door.

R-auth (identity/trade): session/API-key id on order/fill/ledger or named refuse (`PTX-M01-R05`). WebAuthn stays `@simplewebauthn/server` in `svc-identity` — no home-grown attestation.

---

## 7. Wave Q — other backend (second queue; parallel lanes)

Exchange mill must **not** edit protocol Solidity. One service per PR.

| ID          | Service                    | Work                                                                                            | Not                                    |
| ----------- | -------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------- |
| Q-proto     | `svc-protocol`             | Merge #3746 intake; keep unaudited; AMM factory 0x0 stays refuse                                | Fake `audited:true`; invent EntryPoint |
| Q-index     | `svc-indexer`              | `socket.clob-contracts` fixture ABI honesty                                                     | Invent pool reserves                   |
| Q-dex       | `svc-dex`                  | Strip invented 20 bps (H11); do not sell internal CLOB as non-custodial                         | Wire AMM without indexer               |
| Q-pay       | `svc-pay`                  | Chargeback recipes posted or named refuse; no invented smart-routing; `bank-payout` door honest | Hyperswitch; grant `pay:*`             |
| Q-bank      | `svc-bank`                 | H8b PG cooling; card-sim ≠ live issuer                                                          | Invent PSP                             |
| Q-token     | `svc-token`                | Yield/buyback **no cron** honesty; do not mint unpublished magnitudes                           | Invent emission                        |
| Q-mine      | `svc-mining-pool`          | Prove JobHost+PG mint/rewardPay; epoch set or refuse                                            | Money in `number` amounts              |
| Q-edge      | `svc-edge`                 | WS proxy leftover; kill multi-replica honesty                                                   | Invent geo/VPN lists                   |
| Q-notify    | `svc-notify`               | Keep in-app; Class X creds stay dark                                                            | Fake email delivery                    |
| Q-p2p       | `svc-p2p`                  | Instruments not encrypted — refuse live offers or OWNER KMS; do not seed method registry        |                                        |
| Q-market    | `svc-market`               | Recurring sub not built — refuse; commission env blank ≠ 0                                      |                                        |
| Q-ledger    | `svc-ledger`               | Do not recut statements; paged history SOCKET stay refuse                                       | Second book                            |
| Q-ops       | `svc-ops`                  | Wrap/freeze unset refuse; payroll invent forbidden                                              |                                        |
| Q-tax       | `svc-tax`                  | Jurisdiction map OWNER                                                                          | Invent map                             |
| Q-academy   | `svc-academy`              | Paper never ledger (keep); prize recipes refuse                                                 | Import licensed library                |
| Q-support   | `svc-support`              | No refund money (keep)                                                                          |                                        |
| Q-blueprint | `svc-blueprint`            | Mock — SKIP money                                                                               |                                        |
| Q-rust      | `svc-matching-rust-stage1` | Study only — SKIP cutover                                                                       | Replace TS matching                    |

---

## 8. DAG after **go** (3 writers)

Parallel only across **different** `services/*`.

```
Wave 0 merges (#3777 #3708 #3771 #3772; #3746 code; #3707 if allowed)
        │
   ┌────┴────┬────────────────┐
Ken trade    Tom matching     Bob fix → ws
H6 H8 H4t    H2m H4m H5 H9    H1 H1b H3 H2ws
H7t R-E*     R-A7             then Q-edge
R-copy/fx                    then Q-dex bps
        │
Identity serial: rest of #3772 path then R-security / R-onboard
Execution serial: H10
Bank serial: H8b
Protocol: Shehzad lane or Bob when free — Q-proto only
```

`pnpm wt feat/…`. Never door. Never `05_Web_Front`. Decimal strings. `GRAPHIFY_MAX_WORKERS=1 graphify update .` after code; do not commit `graphify-out` in product PRs.

---

## 9. All 26 services (named)

`svc-academy` `svc-agents` `svc-bank` `svc-blueprint` `svc-dex` `svc-edge` `svc-execution` `svc-fix` `svc-identity` `svc-indexer` `svc-ledger` `svc-market` `svc-matching` `svc-matching-rust-stage1` `svc-mining-pool` `svc-notify` `svc-ops` `svc-p2p` `svc-pay` `svc-protocol` `svc-quant` `svc-support` `svc-tax` `svc-token` `svc-trade` `svc-ws`.

None silently dropped. SKIP money: blueprint, rust-stage1, support refunds, academy SFU.

---

## 10. Waste

Docs mill / recook mountains · frontend · invent bps · fake cert/L3/SBE stub as “done” · dual POV/combo · CCXT · wait Nitro/CI · redo convert 10/200 · protocol audited without firm hash · seed P2P registry · academy library import.

---

## 11. Card template

```
CARD: H# | R-* | Q-*
Service: services/<one>
Today: LIVE | UNIT | REFUSE | LIE vs compose
Target door: HTTP | tRPC | NATS | FIX process | JobHost
PG required: Y/N
Money: ledger-client recipes; decimal strings; never JS number
OSS: keep in-repo | EXT lib@sha from §19 | never vibe
Shell freeze: do not recut /api or /ws nginx
Owner sockets I will not fill:
Proof: test that fails without the door
```

---

## 12. Completeness honesty (this stamp)

**Named, not equally deep.** Every service and every PTX ID has a **disposition**. H cards have doors. Q rows were census-thin — expanded in §13–§16 so go is not another 158-line hitch list.

| Set                  | Closed how                                                                                                                                                 | Residual                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 26 `svc-*`           | §9 names all; SKIP four; rest H/R/Q                                                                                                                        | Q proofs land at execute, not in this file                       |
| 266 `PTX-*`          | #3708 inventory: FRONTEND 18 Codex; OWNER 43 refuse; OPS 15; DEFER_OSS 1; ON_MAIN 20 do-not-redo; HITCH+MONEY+DEPTH 169 → **grouped** into H/R not 169 PRs | Inventory file still on #3708 until Wave 0                       |
| Grokbot 15 headlines | 2 LIVE (convert refuse; combo **rest**); rest HARDEN                                                                                                       | Combo **trade** is H4                                            |
| OMS 187 files        | Hitch H10 + extras documented; do not dual-implement                                                                                                       | Full LIVE/PAPER census is execute-time A18 if missing on main    |
| Money skip register  | H8: CI-hard or delete skip; register is law (`tooling/ci/money-skip-inventory.mjs`)                                                                        | Do not add silent skips                                          |
| Compose invented bps | H11: MM ±10, DEX 20                                                                                                                                        | Pool max / interval_ms / body limits are **not** fee bps — leave |

North-star §7.3: do **not** open 169 equal tickets. Completeness = no silent drop + every DEPTH row maps to an H/R/Q card or HUMAN refuse.

---

## 13. Implicit requirements (unspoken, now binding)

1. This owner executes after go — **not grokbot**.
2. Parallel = **three live writers** (one `services/*` each) + explore auditors, not 26 PRs at once.
3. Token spend = prove doors (compose/HTTP/FIX/JobHost/PG), not docs.
4. Mill “IN” merge ≠ live. Re-fetch; falsify importer.
5. Charts are not a backend gate.
6. Blank owner env is the product until a later go-live.
7. Shehzad owns protocol Solidity **audit firm**; we merge intake, we do not fake audited.
8. Frontend agent must not collide: never `05_Web_Front`.
9. Kill-parent unknown ≠ killed; cancel is a request until matching sequence.
10. Paper OMS never ledger. L3 never from L2. SBE never utf8 stub labeled Real Logic.

---

## 14. This-chat fan-out after go (token-efficient)

**Always 3 product worktrees max.** Extra subagents are **read-only falsify**, not fourth writers.

| Slot         | Lane           | First cards after Wave 0           |
| ------------ | -------------- | ---------------------------------- |
| Writer 1     | `svc-fix`      | H1 then H1b                        |
| Writer 2     | `svc-matching` | H2 matching (L3 HTTP) then H5      |
| Writer 3     | `svc-trade`    | H8a PG-hard fee then H6 JobHost    |
| Auditor (ro) | origin/main    | After each merge: door still live? |

Then rotate: Bob → `svc-ws` H3/H2ws; Tom → H4 combo match + H9; Ken → H4 trade + R-E5; serial execution H10 when a slot frees.

Wave Q starts when two of {H1, H2, H8a} are on main **or** named residual.

---

## 15. Wave Q builder cards (was the hole)

Each is one PR. Proof = live door or named refuse on that door.

| ID          | Files to open first                                                  | Today                      | Target / proof                                              |
| ----------- | -------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| Q-proto     | `svc-protocol`; PR #3746                                             | unaudited; AMM 0x0         | Merge intake; refuse `audited:true`; no invented EntryPoint |
| Q-index     | `svc-indexer` clob-contracts socket                                  | fixture ABI                | Honesty: fixture ≠ live CLOB; no invented reserves          |
| Q-dex       | `docker-compose.apps.yml` `DEX_INTERNAL_BOOK_FEE_BPS:-20`; dex quote | invented 20                | Blank refuse; do not call internal book non-custodial       |
| Q-pay       | pay chargeback / `bank-payout`                                       | recipes may not post       | Post via ledger-client **or** named refuse; no Hyperswitch  |
| Q-bank      | `offramp-cooling.ts` + ramps                                         | refuse-unset LIVE; PG skip | H8b: red without PG; card-sim ≠ issuer                      |
| Q-token     | token yield/buyback jobs                                             | no cron                    | Honest: no unpublished mint; no fake buyback                |
| Q-mine      | mining-pool JobHost                                                  | mints/rewards              | PG+JobHost or refuse; amounts not JS `number`               |
| Q-edge      | edge WS / kill                                                       | no WS proxy                | Named leftover; no invented geo list                        |
| Q-notify    | notify fanout                                                        | in-app only                | Keep dark without Class X creds                             |
| Q-p2p       | p2p instruments                                                      | unencrypted                | Refuse live offers until KMS OWNER                          |
| Q-market    | commerce subscriptions                                               | not built                  | Refuse recurring; blank commission ≠ 0                      |
| Q-ledger    | statement-pnl already mill                                           | don’t recut                | Paged history SOCKET refuse; dual-book scan                 |
| Q-ops       | wrap/freeze                                                          | unset                      | Refuse; no invented payroll                                 |
| Q-tax       | tax export                                                           | map OWNER                  | Refuse completeness                                         |
| Q-academy   | paper lobbies                                                        | paper ≠ ledger             | Keep; prize recipes refuse                                  |
| Q-agents    | `svc-agents` guardrails                                              | denylist partial           | R-agentic: install ≠ trade; no withdrawal cred              |
| Q-support   | tickets                                                              | no refund money            | Keep                                                        |
| Q-blueprint | mock                                                                 | SKIP                       |                                                             |
| Q-rust      | rust-stage1                                                          | SKIP cutover               | TS matching stays SoT                                       |

---

## 16. Money-skip law (H8)

Register: `tooling/ci/money-skip-inventory.mjs`. Roots: ledger, trade, pay, bank, p2p, matching, token, market, ws, ledger-client.

After go: new money tests **must not skip** unless listed with kind. H8a/H8b: fee + cooling paths **CI-hard** (delete skip or Testcontainers). Private-probe `svc-pay` evm-chain.live.test.ts — fix or keep listed.

---

## 17. After this spec

Nitro says **go**. This owner: Wave 0 merges, then 3 parallel worktrees on H1 / H2 / H8. No grokbot. No frontend. Human sockets stay blank.

---

## 18. Source of truth (read in this order — every card)

Main still shows north-star **v1.22** until Wave 0 merges. Until then `git show` the PR branches. Do not treat the Grok door as tip.

| Order | File                                                                                   | Owns                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `INTAFACED_DEFINITIVE_BUILD.md`                                                        | Constitution: ledger-client only; no money `number`; `pnpm wt`; one service/PR; never push `main`; vendored shell `:8090`; protocol ≠ ledger writes (`custody-scan`) |
| 2     | `docs/DIRECTION-2026-07-31.md`                                                         | Sealed product: isolated IM, 10×, external-only house, empty options set                                                                                             |
| 3     | `PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md` §0.2–0.3 §8                                  | Exchange universe + OSS take/keep/never + owner sockets                                                                                                              |
| 4     | `docs/INTERNET-LEVERAGE-LAW.md` + `docs/BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md` | Extend `svc-*` + ledger + **existing shell**. No second SPA/book/CLOB                                                                                                |
| 5     | `tooling/agent-protocol/AGENT_PROTOCOL.md`                                             | Graphify then one file; merge when done                                                                                                                              |
| 6     | **This file**                                                                          | What to execute after go                                                                                                                                             |
| 7     | Child `docs/SPEC-PRO-EXCHANGE-*-2026-08-2*.md` (PX-S01–S16)                            | Product semantics; do not rewrite                                                                                                                                    |
| 8     | #3708 inventory + #3777 H-cards                                                        | 266 dispositions + harden detail; merge Wave 0                                                                                                                       |

If this file fights (1)–(4), (1)–(4) win.

---

## 19. OSS — take / keep / never (do not vibe)

Pin **commit SHA**. Adapter ≠ book. Decimal strings on the wire.

| Job                      | Take                                                                            | Keep                                                                               | Never                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Match / halt / IFM / MMP | —                                                                               | `svc-matching`, `packages/execution-mm`                                            | OpenDAX, Hummingbot-as-venue, npm CLOB, Java `exchange-core`, Calvera as book |
| Money                    | —                                                                               | `ledger-client` + `svc-ledger`                                                     | Formance, TigerBeetle, Hyperswitch, CCXT, decimal.js on the wire              |
| HTTP/schema/tests        | —                                                                               | Fastify 5, **Zod 3**, Drizzle, postgres.js, Vitest, fast-check, OTel, `ws`, argon2 | Express, Prisma, Kafka-as-bus, **Zod 4 silent**, OpenAPI generator 9.x        |
| FIX                      | **QuickFIX/J 3.0.2** SHA `6334e2d288e5` (`PIN.quickfixj`; H1 `FixAcceptorMain`) | fills → matching → ledger                                                          | `node-quickfix`, AGPL jPOS, hand-rolled FIX, FalconFIX as engine              |
| FIX tags                 | Official FIX XML                                                                | QFJ DataDictionary                                                                 | Invented tags                                                                 |
| SBE                      | **Real Logic SBE 1.39.0** SHA `e773b57cac6b` (`SBE.pin.json`; H3)               | `packages/sbe-codec` + our schema                                                  | Protobuf-as-SBE; utf8 stub labeled SBE                                        |
| Greeks                   | **QuantLib 1.43** SHA `6b57206e0459` (`QUANTLIB.pin.json`; H7)                  | our mark/clock                                                                     | QuantLib-Python hot path; JS Black-Scholes labeled QuantLib; IEEE NPV         |
| WebAuthn                 | `@simplewebauthn/server`                                                        | `svc-identity`                                                                     | home-grown attestation                                                        |
| OpenAPI                  | `@asteasolutions/zod-to-openapi@7.3.4`                                          | `packages/contracts`                                                               | second schema language                                                        |
| Tests DB                 | Testcontainers **or** per-branch PG                                             | no shared `intafaced_test`                                                         | skip-green money                                                              |
| Bus                      | —                                                                               | **NATS**                                                                           | Aeron/Kafka replace                                                           |
| PM scenarios             | **ORE later**                                                                   | IM/MM + ledger                                                                     | ORE as book; vibe VaR                                                         |

H1/H3/H7 **are** the OSS hitch. Do not hand-roll a parser to look busy.

---

## 20. Right shell (backend must not fight Codex)

Sole product surface = vendored Vue shell **`:8090`** (`vendor/upstream-exchange/05_Web_Front`). `apps/web` retired. **Never a second SPA.** Charts/TradingView = Codex + licence; never pirate TV into git; never npm a fake Advanced Charts pack.

This owner:

- Does **not** edit `05_Web_Front`, `04_Web_Admin` as a second product, `packages/ui`, M07.
- **Does** keep existing REST / tRPC / WS / FIX contracts the shell already calls. Breaking a live ticket/blotter/depth door to “clean up” is a fail.
- **Nginx freeze:** `/api/` → `svc-edge:4000` (tRPC ` /api/<module>/trpc/<procedure>` **and** CCXT-**shaped** REST `/api/v1/*` — not npm `ccxt`). `/ws/` → `svc-ws:4014` **with path rewrite**. Q-edge must **not** recut that rewrite.
- New backend fields are additive or refused — not silent shape changes.
- Admin patterns: prefer existing `04_Web_Admin` **shape**; no new admin SPA.
- Wallet RPC critical defects stay frozen — do not invent hot wallets or mainnet dual-broadcast. Not a Wave H card unless a custody PR is in-flight.

---

## 21. Packages (named — was a hole)

| Package                                      | Disposition                                         |
| -------------------------------------------- | --------------------------------------------------- |
| `ledger-client`                              | KEEP; only money writes; dual-book scan             |
| `sbe-codec`                                  | H3 hitch into `svc-ws` image                        |
| `greeks-adapter`                             | H7 one service consumer                             |
| `contracts`                                  | Zod 3 OpenAPI pin; no Zod 4                         |
| `events`                                     | NATS keep                                           |
| `execution-mm`                               | KEEP MMP law in-repo; H5 HTTP in matching           |
| `execution-arb` / `execution-house-tenant`   | external-only house; no internal book MM            |
| `venue-adapter`                              | ON_MAIN adapters; no CCXT; Q/R best-ex claim refuse |
| `market-data`                                | H2/H3 consumer path; don’t fork a second MD stack   |
| `auth`                                       | identity; WebAuthn adapter                          |
| `quant-honesty`                              | R-quant; paper ≠ live                               |
| `db` / `config` / `telemetry` / `safe-regex` | keep                                                |
| `ui` / i18n for shell                        | Codex                                               |
| `connect-data-lake` / `portfolio-view`       | no second warehouse as money book                   |

---

## 22. Extra implicit (doctrine, not mountains)

- Halt **≡** cancel-only. Restart ≠ OPEN.
- Protocol plane **must not** import `ledger-client` write recipes (`custody-scan`).
- Wallet RPC critical defects stay frozen until fixed — do not invent hot wallets / mainnet dual-broadcast (leverage law).
- First code-location: `graphify query` budget 400, then one file.
- After `services/` `packages/` edits: `GRAPHIFY_MAX_WORKERS=1 graphify update .` — do not commit `graphify-out` in product PRs.
- `pnpm wt feat/…` from **origin/main**. Never Grok door. Never bare `git worktree add`.
- One writer per `services/*`. Max 3 product worktrees.
- Merge when Gitleaks green; trunk GHSA `--admin` only if this diff did not add it; if GitHub blocks, comment and continue.

---

## 23. Go ritual (this owner, no further Nitro prompt)

1. Re-fetch `origin/main`.
2. Wave 0: merge #3779 (this), #3777, #3708, #3771, #3772; #3746 code; #3707 if allowed.
3. Three worktrees: H1 `svc-fix` · H2 `svc-matching` · H8 `svc-trade`.
4. Rotate per §14. Wave Q when two of H1/H2/H8a exist.
5. Never ping. Blank §8 stays refuse. Never frontend.
