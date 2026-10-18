# Claim NITRO-FRONTEND-ALL

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** agent-afk-day
**owner:** nitro-afk-agents
**proof:** Nitro 24h AFK BUILD DAY directive (paste 2026-08-05) — honesty / money-on-wire / wire validation / landing honesty only. Expires after wave or Nitro reclaims HUMAN.
**tip:** c742cfd5
**updated:** 2026-08-05

## Scope — agents MAY edit under these paths for this AFK day only

| Path                                    | What it is                                          |
| --------------------------------------- | --------------------------------------------------- |
| `vendor/upstream-exchange/05_Web_Front` | the sole product surface (`:8090`)                  |
| `vendor/upstream-exchange/04_Web_Admin` | vendored staff console (not served)                 |
| `apps/web`                              | retired Next scaffold (see ADR) — **do not re-add** |
| `apps/admin`                            | operator console (`:3100`)                          |
| `packages/ui`                           | design tokens + console primitives                  |
| `packages/i18n`                         | language keys                                       |

## Allowed craft (this day)

- Money-on-wire honesty (ix-money call sites, order body strings)
- Landing honesty (notTraded / provenance / no fake sparklines)
- Announcement strip / IxNoSurface stated absence
- ix-wire golden + accept() at REST read sites
- Terminal residual that does **not** invent product law

## Forbidden (still)

- Palette re-pick, retail IA redesign
- Invent prices / depth UI product / Class X
- Dual-edit open partner PR file sets (#428, #346, #792)

## Wave 1 RP status (re-derived tip `c742cfd5`)

| RP  | Status on tip                                                                                                      | Proof                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| S1  | **DONE** — `useBookPrice` / `applyPercent` / `toCreateOrderBody` use ix-money + string wire                        | `node vendor/upstream-exchange/05_Web_Front/src/assets/js/ix-money.golden.js` · Exchange.vue + ix-trade.js |
| S2  | **DONE** — Index notTraded / noneTraded / provenance; PRICE TREND removed                                          | Index.vue header comments + `noneTradedYet`                                                                |
| S3  | **DONE** — cms.announcements strip via sockets.js + IxNoSurface; no empty toast lie                                | sockets.js `cms.announcements` + IxNoSurface                                                               |
| S4  | **DONE** — ix-wire schemas + `ixTrade.accept` on Exchange REST reads; golden refuses float / 19dp / custodial:true | ix-wire.golden.js · Exchange.vue accept gates                                                              |
| S5  | residual — socket panel / order-ticket refusal ladder polish only if still dishonest                               | open                                                                                                       |

When Nitro reclaims: set **status:** HUMAN and LIVE-LANES row back to HUMAN.
