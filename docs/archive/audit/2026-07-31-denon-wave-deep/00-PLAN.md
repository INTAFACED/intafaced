# 00-PLAN — Denon money/spine deep audit (backend only)

**Realign 2026-07-31:** Operator interrupted frontend/ADR drift. This fire is **audit · review · debug · fix · stress** on **services/packages** only. **No vendor Stream A / frontend.**

**Tip:** `2dc706b` (#251 money-class closed — do not re-judge #226–#228 unless regression)
**Prior closed:** money-class mega archive `docs/audit/2026-07-31-money-class-mega/`
**Gap named in STATUS:** full adversarial money pass on Denon **#201–#218** never done (WAVE only)

## Primary targets (backend)

| PR      | Surface                                  | Why                               |
| ------- | ---------------------------------------- | --------------------------------- |
| #202    | bank loans collateral/LTV/liquidation    | money                             |
| #214    | hosted checkout + sandbox stranger money | money                             |
| #206    | trade placeOrder rank S2S P0             | money/auth                        |
| #201    | trade CCXT contract answers              | money API honesty                 |
| #209    | venue fabric fill honesty                | money/truth                       |
| #217    | token factory chain honesty              | plane                             |
| #218    | indexer read models                      | projection honesty                |
| #210    | protocol CREATE2 / dev chain             | plane                             |
| #211    | test DB isolation                        | test integrity                    |
| M226-03 | watcher mark-before-2xx                  | agent P2 polish from prior critic |

## Out of scope

- vendor/\*\* Stream A, apps shell polish, dual-book ADR product policy write
- Inventing durable multi-replica BroadcastStore (M226-01 Denon)
- Futures/OTC/algo product invent

## Parallel map

A bank #202 · B pay checkout #214 · C trade #201/#206 · D venue #209 · E protocol/indexer #210/#217/#218 · F implement M226-03 + stress tests
