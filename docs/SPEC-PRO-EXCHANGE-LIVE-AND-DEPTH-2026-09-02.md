# SPEC — Live-wire, money proof, and mountain depth (backend)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Child contract of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md) **v1.22**  
**Date:** 2 September 2026  
**Audience:** Grok bot + 3 parallel builders. Nitro does not brief you.  
**Scope:** Backend only. Codex owns `vendor/upstream-exchange/05_Web_Front`.  
**This is not a second north-star.** Mountains stay M00–M28. This file is the **implementation campaign**: hitch what exists, prove money, then add depth with named OSS.

---

## 0. What “done” means

A professional venue is **not** “a refuse module exists.” It is:

1. The live path actually calls the door (hitch).
2. Money cannot move on an invented rate, fill, or book (proof).
3. Depth that a primary venue needs is real behavior or a **named** refuse — never a silent weaken.

**Stop inventing owner numbers.** Fees, cooling hours, DMA law, portfolio scenarios, MMP, haircuts, rulebook version, ADL `maxReduceBps` stay `OWNER-SET`. Blank refuses.

**Stop vibe-coding codecs.** FIX / SBE / Greeks use north-star §0.3. Matching, money, MMP stay in-repo.

---

## 1. Landscape (OSS) — 2026-09-02 pass

Re-checked against current public stack. Does **not** replace §0.3. Adds only what the depth campaign needs.

| Job                                 | Take (pin SHA)                                                             | Keep                                       | Never                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Match / IFM / STP / combo book / L3 | —                                                                          | `svc-matching`                             | OpenDAX, Hummingbot-as-venue, npm CLOB, Java `exchange-core`, Calvera/IronFix **as the book** |
| Money                               | —                                                                          | `ledger-client` + `svc-ledger`             | Formance, TigerBeetle, Hyperswitch, CCXT, decimal.js on the wire                              |
| FIX session                         | **QuickFIX/J 3.0.2** already in `services/svc-fix`                         | fills → matching → ledger                  | `node-quickfix`, AGPL jPOS, hand-rolled FIX, FalconFIX (not a mature public engine)           |
| SBE codec + **feed**                | **Real Logic SBE 1.39.0** already in `packages/sbe-codec`                  | our schema; publish via `svc-ws` / MD path | Protobuf-as-SBE; IronSBE swap; Aeron bus replace (NATS stays)                                 |
| Greeks / calendars                  | **QuantLib 1.43** already in `packages/greeks-adapter`                     | live mark + ledger clock ours              | QuantLib-Python hot path; JS Black-Scholes labeled QuantLib; IEEE NPV on the wire             |
| Portfolio **scenario** math (later) | **Open Source Risk Engine (ORE)** — QuantLib-based, when PM mountain is on | IM/MM still our ledger                     | ORE as money book; vibe-coded VaR                                                             |
| Tests                               | Testcontainers-node **or** per-branch Postgres                             | law: no shared `intafaced_test`            | Skipping the money path and calling it green                                                  |
| WebAuthn / OpenAPI / FIX XML        | as §0.3                                                                    | —                                          | Zod 4 silent upgrade                                                                          |

**Defer (good, wrong now):** Aeron (NATS is the bus); Artio (Aeron-coupled; first FIX door is QFJ); ClickHouse/Kafka warehouse.

**Already on `origin/main` (do not redo):** IFM module, POV unit doors, bank cooling refuse, basket unit door, statement PnL refuse, QuantLib adapter (unlinked refuse), margin 2×2 **names**, QuickFIX/J adapter + matching HTTP port, SBE codec, surveillance **helper**, DMA refuse, dated-futures refuse, fee **preview + placeOrder** schedule, option combo **refuse**, rulebook GET, convert/slippage refuse PRs may be open.

---

## 2. Campaign A — Live-wire / hitch

A file that only unit-tests is **not** shipped. Hitch or delete the lie.

| ID  | Service         | Work                                                                                                                                                                                                                                                                                         | Proof                                                                                                                |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A1  | `svc-matching`  | Merge or re-land **STP opens a surveillance case on the live book** (`book.match` / `engine.submit`). Helper-only is a fail. Open PR **#3702** if still open.                                                                                                                                | Submit STP → named `self_trade` case. No fine, no ledger.                                                            |
| A2  | `svc-trade`     | Merge or re-land **convert spread + slippage cap refuse when unset**. Defaults 10 / 200 bps are invented owner numbers. Open PR **#3703** if still open.                                                                                                                                     | Blank env refuses convert quote/execute and market-buy hold. Compose must not inject 10/200.                         |
| A3  | `svc-execution` | Hitch `startBasketParent` onto a real admin/tRPC door **or** prove `sliceLiveAlgoParent` already covers basket. Do not leave `oms-basket-start.ts` test-only.                                                                                                                                | One HTTP/tRPC call exercises the refuse.                                                                             |
| A4  | `svc-execution` | Hitch POV `slicePovParent` / stop / expire / residual **or** prove generic `oms-slice.ts` (`kind: pov`) is the live path and the unit files are extras. If extras, document that in the PR body — do not dual-implement.                                                                     | Live `execution.oms.slice` on a POV parent uses ledger qty strings.                                                  |
| A5  | `svc-fix`       | FIX `MatchingOrderCommand` must carry **account + TIF** (tag 1 / 59). Matching submit today needs `accountId`, UUID `orderId`, `tif`, `lifecycleProof`. Missing map → `matching_account_unmapped` / `tif_missing`. Never invent an account. CompID→account is OWNER-SET JSON; blank refuses. | Integration test with fake matching: unmapped CompID refuses **before** POST; mapped CompID posts decimal qty/price. |
| A6  | `svc-fix`       | Strip matching ack **passthrough**. Do not relay extra `fills[]` / last / account from HTTP 200 as if svc-fix minted them. `sequence` is matching’s, not IEEE money.                                                                                                                         | Schema: only named ack fields.                                                                                       |
| A7  | `svc-matching`  | `GET /rulebook` exists. Pass `MATCHING_RULEBOOK_VERSION` in compose **without** inventing a version. Blank stays unpublished.                                                                                                                                                                | Container without env still unpublished.                                                                             |
| A8  | `svc-matching`  | Option combo: live `submit` already refuses via `comboIntentRefuse`. Keep refuse until combo **book** (D2). Do not silently rest two options.                                                                                                                                                | Existing hitch stays.                                                                                                |

One service per PR. **#3702 and #3703 first** if still open (Gitleaks green; Dependency audit may be repo-wide GHSA — merge `--admin` only if Gitleaks + dep are the historical pair and dep is trunk-wide, else fix the scan).

---

## 3. Campaign B — Money proof (no skipped green)

Postgres down ≠ green. `fast-check` already in-repo — use it.

| ID  | Service                | Work                                                                                                                                                                                                           | Proof                                 |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| B1  | `svc-trade`            | Place/fill with **unpublished** `TRADE_FEE_SCHEDULE` refuses **before** `withdrawHold` / fill recipe. Published schedule drives `ratesForFill`, never listing 10/20. Run with Testcontainers or per-branch DB. | Red without DB is a fail.             |
| B2  | `svc-bank`             | Offramp with blank `BANK_OFFRAMP_COOLING_HOURS` refuses before `withdrawHold`. Journal empty.                                                                                                                  |                                       |
| B3  | `svc-matching`         | IFM: crash after `in_flight` journal, before apply → `in_flight_unknown`; no second rest; no duplicate fill. Replay must not invent cancel.                                                                    | FileJournal encode includes the flag. |
| B4  | `svc-trade` + matching | Matching 200 then process death before trade sees fill: hold stays; no invented settle. Reconcile job default remains honest (off ≠ silent fill).                                                              |                                       |
| B5  | `svc-ledger`           | Statement PnL: missing lots/marks/NAV → named refuse, never `0`. Router hitch already; add S2S test if missing.                                                                                                |                                       |
| B6  | dual-book              | `pnpm scan:dual-book-door` (or gates) on every money PR.                                                                                                                                                       |                                       |

---

## 4. Campaign C — Mountain depth (the large remaining product)

Do **not** start C until A1–A2 are on `main` (open PRs) and B1 has a live DB proof **or** an explicit skip named in the PR as residual.

| ID  | Mountain  | Service                            | Behavior                                                                                                                                                                                             | OSS            |
| --- | --------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| D1  | M05       | `svc-fix`                          | Live FIX **session**: logon / heartbeat / resend / logout via QuickFIX/J. Versions 4.2 / 4.4 / 5.0 explicit. Unsupported BeginString refuses.                                                        | QFJ 3.0.2      |
| D2  | M05       | `svc-fix`                          | NewOrderSingle → matching **after** A5. ExecutionReport from matching ack. No ledger in svc-fix.                                                                                                     | QFJ            |
| D3  | M05 / M06 | `svc-ws` or `packages/market-data` | SBE **public tape** using `packages/sbe-codec` + our schema. L2 first. L3 only from matching native queue — **never** synthesize L3 from L2.                                                         | Real Logic SBE |
| D4  | M11       | `packages/greeks-adapter`          | Link native QuantLib 1.43 **or** keep refuse. Decimal strings out. No IEEE on the wire (fix `ieee-decimal` / N-API double if linking). No JS Black-Scholes.                                          | QuantLib 1.43  |
| D5  | M11       | `svc-matching`                     | Combo **book**: named legs + ratios rest as one instrument. Until then keep refuse (A8).                                                                                                             | IN matching    |
| D6  | M08       | `svc-trade`                        | Isolated remains the live IM product. Portfolio **math** only with owner scenarios; until then `trade.portfolio_margin_unset`. Optional later: ORE adapter for scenarios, decimal out, not the book. | ORE later      |
| D7  | M10       | `svc-trade`                        | Dated futures **settlement job**: owner fixing decimal string; never last trade. Blank `TRADE_FUTURES_SETTLEMENT_FIXING` already refuses listing.                                                    | IN             |
| D8  | M09       | `svc-trade`                        | Insurance / ADL: keep `trade.adl_unconfigured` without owner `maxReduceBps`. Do not invent ranking.                                                                                                  | IN             |
| D9  | M16       | `svc-matching`                     | Surveillance **over time**: persist open cases; spoofing/layering remain named reasons that refuse auto-adjudicate. Not a vendor SURV product.                                                       | IN             |
| D10 | M14       | `svc-ledger`                       | Statements when lots **exist** (happy path) plus existing missing-lot refuse.                                                                                                                        | IN             |
| D11 | M19       | `svc-matching` or sandbox svc      | Public testnet / FIX cert **program** is ops. Code: refuse “certified” without `MATCHING_RULEBOOK_VERSION`. Do not fake a cert.                                                                      | —              |
| D12 | M06       | `svc-matching`                     | Native L3/queue as matching truth. WS may project it. Never invent L3.                                                                                                                               | IN             |

---

## 5. Owner / ops (not builder invent)

| Knob                                                         | When Nitro sets it               | Until then                          |
| ------------------------------------------------------------ | -------------------------------- | ----------------------------------- |
| `TRADE_FEE_SCHEDULE`                                         | Before a live fill               | `trade.fee_schedule_blank`          |
| `BANK_OFFRAMP_COOLING_HOURS`                                 | Before a live offramp            | `bank.offramp_cooling_unset`        |
| `MATCHING_RULEBOOK_VERSION`                                  | Before best-ex / certified claim | unpublished                         |
| `IDENTITY_DMA_HIERARCHY_LAW_JSON`                            | First broker client              | DMA refuse                          |
| `TRADE_FUTURES_SETTLEMENT_FIXING`                            | First dated listing              | dated refuse                        |
| ADL `maxReduceBps`                                           | Liquidation desk exists          | `trade.adl_unconfigured`            |
| CompID→account JSON                                          | First FIX customer               | `matching_account_unmapped`         |
| `INTAFACED_QUANTLIB_NATIVE`                                  | Selling options Greeks           | adapter unlink refuse               |
| `TRADE_CONVERT_SPREAD_BPS` / `TRADE_MARKET_SLIPPAGE_CAP_BPS` | Convert / market-buy live        | refuse (A2) — **no default 10/200** |

---

## 6. How three builders work

Grok bot dispatches. **One service per PR.** Parallel only across **different** `services/*`.

Suggested lanes (repeat until the campaign ID is on `main`):

| Builder | Lane                 | First cards                                                                            |
| ------- | -------------------- | -------------------------------------------------------------------------------------- |
| Ken     | `svc-trade`          | A2 (#3703) → B1 → D7/D6/D8 as deps allow                                               |
| Tom     | `svc-matching`       | A1 (#3702) → A7 → A8/D5 → D9 → D12                                                     |
| Bob     | `svc-fix` + packages | A5 → A6 → D1 → D2; SBE feed D3 with Tom if `svc-ws` (then **not** same PR as matching) |

`svc-execution` hitch (A3/A4) is a **fourth serial** after a lane is free — do not fourth-writer collide.

`pnpm wt feat/…`. Never `git worktree add`. Never push `main`. Never the Grok door. Never `05_Web_Front`. PR names `IN <svc>` or `EXT <lib>@<sha> adapter-only`. Money: ledger-client, decimal strings, never JS `number`. Comment [#3446](https://github.com/Phantom-X-007/intafaced/issues/3446) when one lands.

If already on `origin/main`, STOP that card.

---

## 7. Hallucination guards

- Re-fetch `origin/main` every card. Do not audit the Grok **door** checkout (it is diverged).
- `graphify query` then one file.
- After `services/` / `packages/` edits: `GRAPHIFY_MAX_WORKERS=1 graphify update .` — do not commit `graphify-out` in a product PR.
- Do not read Phase A “FIX not found” as a ban on QuickFIX/J.
- Do not use `SPEC-FACTORY-INDEX-2026-08-04.md` as this campaign’s index.
- Tests that skip Postgres are **not** B1/B2 green.

---

## 8. Out of campaign

Frontend / Codex. New SPA. Second money book. Invented bps/hours. Recooking M00–M28 as a new mountain list. Aeron-for-NATS. CCXT.

---

## 9. Gap hunt (this stamp)

Poked and **included**: hitch vs unit-only (A3–A4, A1); invented 10/200 (A2); FIX identity/TIF (A5); ack passthrough (A6); compose rulebook (A7); combo book vs refuse (A8/D5); IEEE Greeks (D4); ORE as later PM adapter not book; L3 never from L2 (D3/D12); money e2e (B); owner knobs (5); 3-builder collision rule (6); door vs GitHub (7).

**Not in this campaign (ops/people):** public marketing site for the rulebook; KYB shop; insurance legal entity; GitHub Actions GHSA on `sharp`/`postcss` (repo-wide — do not block substance PRs if Gitleaks is green and dep fail is trunk-identical).
