# Research pack — `trade.futures` (residual campaign)

**Date:** 2026-07-31  
**Status:** research complete · **no product code in this PR**  
**Campaign:** `docs/NITRO-RESIDUAL-CAMPAIGN-2026-07-31.md` R6  
**Owner:** Nitro residual campaign

---

## 1. Law (what “done” must satisfy)

From `INTAFACED_DEFINITIVE_BUILD.md` (trade futures):

- Markets kind includes `futures`
- Positions: side, size, entry, margin_mode (cross/isolated), margin, liq_px, funding_paid
- Order path: `ledger.hold` of **margin** (not full notional as if spot)
- Mark price from index feed
- Liquidation engine job: liq_px vs mark, partial ladder, insurance fund backstop
- Funding every 8h as **ledger recipes**
- All money via `packages/ledger-client` only; purpose-keyed collateral `position:<id>` already anticipated in ledger-client

Doctrine:

- No balances outside ledger
- No money as JS `number`
- Fail closed on incomplete derivatives surface (current honesty pattern)

---

## 2. On main now (honest inventory)

| Surface                               | State                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Spot order/hold/fill                  | Done                                                                      |
| `MarketKind` includes `'futures'`     | Type exists; no futures markets listed productively                       |
| GET `/api/v1/positions`               | **200 + `[]`** with signed principal; auth fail-closed                    |
| POST leverage / margin-mode           | **Refuse** `trade.leverage_unsupported` / `trade.margin_mode_unsupported` |
| GET funding-rate                      | Honest refuse for spot; no fabricated zero                                |
| `positionUpdated` event               | Catalogued; ws fans out when published; **nothing publishes**             |
| Private WS positions channel          | Mounted; empty-honest (ready frame only) — #227 + tracker #263            |
| Ledger `userCollateral(..., purpose)` | Shape ready for `position:<id>`                                           |
| Futures recipes                       | **Not implemented**                                                       |
| Liquidation / funding jobs            | **Not implemented**                                                       |
| Insurance fund                        | **Not implemented**                                                       |

---

## 3. Gaps that block tracker `done`

1. Position open/close lifecycle + ledger margin hold/release recipes
2. Mark/index price path (no invent; socket if feed missing)
3. Liquidation job + insurance fund accounting
4. Funding schedule job (8h) as recipes
5. Cross vs isolated margin modes
6. Wire `positionUpdated` from engine → bus → ws
7. Tests: concurrent claims, fail closed, no double hold, liquidation conservation
8. Mount futures markets only when engine real (no propped listings)

---

## 4. DoD (checkable proofs)

A feature slice may merge when:

| #   | Proof                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------- |
| D1  | Recipe suite: open margin hold, increase/decrease, close, liquidate — all ledger-client; conservation tests |
| D2  | GET `/positions` returns real rows for open positions; still `[]` when none                                 |
| D3  | Leverage/margin-mode either real or still refuse (no silent 200)                                            |
| D4  | `positionUpdated` published on size/margin change; ws test with bus                                         |
| D5  | Liquidation job dry-run tests with fixed marks (no live oracle required for unit)                           |
| D6  | Funding job posts recipe or refuses when market not futures                                                 |
| D7  | Tracker note updated; **not** `done` until D1–D6 + reachable mount                                          |

---

## 5. Risks

| Risk                           | Mitigation                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Inventing mark prices          | Refuse / empty until index feed; no `0` funding lie                               |
| Double margin hold             | Idempotency keys + ledger recipes                                                 |
| Liquidation wrong size         | Partial ladder unit tests + insurance residual named                              |
| Class M merge rubber-stamp     | Self-audit + adversarial second pass on every money PR                            |
| Colliding with Denon spine WIP | Orient `feat/spine-derivatives` before coding; prefer tip greenfield if crash WIP |

---

## 6. Collision map

- `feat/spine-derivatives` remote may exist — **read before coding**; no force-push
- Stream A shell: positions UI consumes API only — no vendor edits in futures PRs
- `ws.gateway` already ready for events

---

## 7. First PR sequence (after this research lands)

| PR  | Concern                                                                        | Class |
| --- | ------------------------------------------------------------------------------ | ----- |
| F1  | `packages/ledger-client` futures margin recipes + unit conservation tests only | M     |
| F2  | `svc-trade` positions table + open/close path using recipes (no liq job yet)   | M     |
| F3  | Publish `positionUpdated` + wire tests                                         | P/M   |
| F4  | Liquidation job skeleton + tests with injected marks                           | M     |
| F5  | Funding job skeleton + tests                                                   | M     |

**First code PR = F1 only.** No markets live until F2 green.

---

## 8. Explicit non-goals for first wave

- UI hotkeys/terminal (Stream A / residual-terminal)
- Options
- Copy trading / OTC
- Claiming tracker `done` early
- Using MemoryChain-style props for marks

---

## 9. Adversarial pre-check (this pack)

- [x] Does not invent product numbers
- [x] Aligns with existing honest empty positions
- [x] Uses purpose-keyed collateral already in ledger-client
- [x] Split so each PR is one concern
- [x] Named residual if insurance incomplete after F4

**Research accepted for campaign COOK.** Next fire: open F1 worktree from tip after #264/#266 merge.
