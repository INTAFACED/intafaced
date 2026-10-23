# Tracker research pack — TRK specs

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Night-engine research** (no implement swarm). One short spec per free tracker
row so ship later is planned, not invented mid-PR.

| Field           | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| **DoD (plain)** | What “done” means for Nitro without code                           |
| **Path on tip** | Service / package / app that owns residual                         |
| **Blocked by**  | Money spine, Denon product law, Class X, unknown, or free residual |
| **First PR**    | Smallest honest first slice if ever free to implement              |

**Law:** Class N docs. Implement only after LIVE-LANES claim + tracker mountain
event when someone actually ships. Human-claimed Shehzad M1–M7 remain babysit
only. Research packs **do not** edit `tooling/tracker/features.mjs`.

---

## Deepen wave 4 — missing implementable specs (tip freeze `318425e8`)

P3: `ops.kb-workflow` had **no** `docs/ops/trk` file (0 lines) while the row
computed **ready** after `ops.support` flipped `done`. Code-grounded cook spec
(≥100 lines): Done bar · file map · refuse codes · test names · Class N ·
Phase A leverage (`svc-support`, not a second service).

| Id                | Spec                                       | Why this wave                                  |
| ----------------- | ------------------------------------------ | ---------------------------------------------- |
| `ops.kb-workflow` | [ops.kb-workflow.md](./ops.kb-workflow.md) | Extraction of support KB; workflow half parked |

Inspected and **not** deepened here: `pay.fraud` (done) · `bank.auto-invest`
(wip/`nitro-w10-l08`) · `tax.engine` (blocked on data-lake + indexer; counsel)
· `quant.sdk` (invent-risk; blocked on studio + SOR) ·
`connect.latency-grading` (computed blocked on `venue.aggregation`; fabric
already on tip).

---

## Deepen wave 3b — ops.support + academy/agents residual thins (tip freeze `083ef879`)

After #717 wave3 (trade/ops/p2p residual), remaining shorts under 100 lines were
`ops.support` plus all `academy.*` / `agents.*` packs. Deepened to code-grounded
≥120-line research specs. Research only — no implement, no `features.mjs`.

| Id                      | Spec                                                   |
| ----------------------- | ------------------------------------------------------ |
| `ops.support`           | [ops.support.md](./ops.support.md)                     |
| `academy.curriculum`    | [academy.curriculum.md](./academy.curriculum.md)       |
| `academy.certs`         | [academy.certs.md](./academy.certs.md)                 |
| `academy.paper-trading` | [academy.paper-trading.md](./academy.paper-trading.md) |
| `academy.spatial`       | [academy.spatial.md](./academy.spatial.md)             |
| `academy.tournaments`   | [academy.tournaments.md](./academy.tournaments.md)     |
| `academy.ambassadors`   | [academy.ambassadors.md](./academy.ambassadors.md)     |
| `agents.navigator`      | [agents.navigator.md](./agents.navigator.md)           |
| `agents.support`        | [agents.support.md](./agents.support.md)               |
| `agents.scanner`        | [agents.scanner.md](./agents.scanner.md)               |
| `agents.merchant`       | [agents.merchant.md](./agents.merchant.md)             |
| `agents.copy-intel`     | [agents.copy-intel.md](./agents.copy-intel.md)         |

**Honesty highlights:** curriculum day-one spine (6 items) ≠ 20+3 import; paper
flag is trade-owned; spatial scene jsonb exists, canvas product residual;
ambassador/tournament pay Class M; agents routing ≠ product; merchant/copy-intel
babysit Shehzad M1/M4; support agent needs ops.support KB.

---

## Deepen wave 3 — trade/ops/p2p residual shorts (tip freeze `56696496`)

In-place deepen of ten short-name packs still thin (~66–72 lines) after wave 2,
into code-grounded long-form research (≥120 lines each). Research only — no
implement, no `features.mjs`. freeProduct=0 AFK **P3** (priority ladder).

| Id                       | Spec                                                     |
| ------------------------ | -------------------------------------------------------- |
| `p2p.merchants`          | [p2p.merchants.md](./p2p.merchants.md)                   |
| `mining.pool`            | [mining.pool.md](./mining.pool.md)                       |
| `ops.affiliates`         | [ops.affiliates.md](./ops.affiliates.md)                 |
| `ops.analytics`          | [ops.analytics.md](./ops.analytics.md)                   |
| `ops.compliance`         | [ops.compliance.md](./ops.compliance.md)                 |
| `blueprint.attestations` | [blueprint.attestations.md](./blueprint.attestations.md) |
| `trade.forex`            | [trade.forex.md](./trade.forex.md)                       |
| `trade.options`          | [trade.options.md](./trade.options.md)                   |
| `dex.quote-router`       | [dex.quote-router.md](./dex.quote-router.md)             |
| `trade.ccxt-api`         | [trade.ccxt-api.md](./trade.ccxt-api.md)                 |

**Honesty highlights:** dex quote code finished / venue socket residual; trade.forex
hours mostly done, settlement rails not; trade.options blocked multi-asset/M3;
compliance list content Class X; mining.pool greenfield; p2p badges derived,
programme packaging residual; no ccxt in money path.

---

## Deepen wave 2 — ops + blueprint + launch (tip freeze `d9e517bd`)

In-place deepen of ten short-name packs that were still thin (~48–66 lines) into
code-grounded long-form specs (≥120 lines each). Same pattern as #713
chain+launch+market deepen. Research only — no implement, no `features.mjs`.

| Id                    | Spec                                               |
| --------------------- | -------------------------------------------------- |
| `infra.i18n`          | [infra.i18n.md](./infra.i18n.md)                   |
| `ops.notifications`   | [ops.notifications.md](./ops.notifications.md)     |
| `ops.admin`           | [ops.admin.md](./ops.admin.md)                     |
| `launch.nft`          | [launch.nft.md](./launch.nft.md)                   |
| `market.vendors`      | [market.vendors.md](./market.vendors.md)           |
| `blueprint.ownership` | [blueprint.ownership.md](./blueprint.ownership.md) |
| `bridge.canonical`    | [bridge.canonical.md](./bridge.canonical.md)       |
| `blueprint.card`      | [blueprint.card.md](./blueprint.card.md)           |
| `launch.meme-factory` | [launch.meme-factory.md](./launch.meme-factory.md) |
| `indexer.readmodels`  | [indexer.readmodels.md](./indexer.readmodels.md)   |

**Honesty highlights:** shell-i18n #425/#714 on tip; notify multi-channel shipped
credentials residual; admin kill/freeze live (tracker note stale); ownership
cascade #229 (tracker note stale); indexer residual = `socket.clob-contracts`;
bridge/meme/nft greenfield + Shehzad adjacency babysit; market.vendors needs
`svc-market`.

---

## Pack 6 — solid layer (tip freeze `04f9b1f2`)

Long-form `TRK-*.md` research for free tracker rows that already have short
specs. Same pattern as `TRK-ops.admin` / `TRK-infra.i18n` / `TRK-ops.notifications`.
Does **not** replace shorts. Research only — no features.mjs.

| Id                       | Solid                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| `agents.scanner`         | [TRK-agents.scanner.md](./TRK-agents.scanner.md)                 |
| `blueprint.attestations` | [TRK-blueprint.attestations.md](./TRK-blueprint.attestations.md) |
| `blueprint.ownership`    | [TRK-blueprint.ownership.md](./TRK-blueprint.ownership.md)       |
| `bridge.canonical`       | [TRK-bridge.canonical.md](./TRK-bridge.canonical.md)             |
| `indexer.readmodels`     | [TRK-indexer.readmodels.md](./TRK-indexer.readmodels.md)         |
| `launch.meme-factory`    | [TRK-launch.meme-factory.md](./TRK-launch.meme-factory.md)       |
| `launch.nft`             | [TRK-launch.nft.md](./TRK-launch.nft.md)                         |
| `mining.pool`            | [TRK-mining.pool.md](./TRK-mining.pool.md)                       |
| `market.vendors`         | [TRK-market.vendors.md](./TRK-market.vendors.md)                 |
| `ops.affiliates`         | [TRK-ops.affiliates.md](./TRK-ops.affiliates.md)                 |
| `ops.analytics`          | [TRK-ops.analytics.md](./TRK-ops.analytics.md)                   |
| `ops.compliance`         | [TRK-ops.compliance.md](./TRK-ops.compliance.md)                 |
| `p2p.merchants`          | [TRK-p2p.merchants.md](./TRK-p2p.merchants.md)                   |
| `trade.forex`            | [TRK-trade.forex.md](./TRK-trade.forex.md)                       |
| `trade.options`          | [TRK-trade.options.md](./TRK-trade.options.md)                   |

**Honesty:** `blueprint.ownership` cascade shipped (#229); indexer residual =
`socket.clob-contracts`; `trade.options` blocked on Shehzad futures M3;
bridge/meme design/Shehzad; compliance list content Class X.

---

## Pack 5 — `docs/trk-research-pack-5` (chain / launch / market)

**Chain / launch / market** rows. Research only — several sit on Shehzad protocol
runway (babysit implement). `venue.aggregation` also in pack 3; one spec file.
**Deepened 2026-08-04** (`docs/trk-deepen-chain-market`, tip freeze `c7af0849`): all
eight short packs expanded to long-form code-grounded research (≥120 lines each).

| Id                     | Title                                                | Spec                                                 | Implement note                                       |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `chain.mainnet`        | INTACHAIN — CometBFT + native CLOB                   | [chain.mainnet.md](./chain.mainnet.md)               | Shehzad **S-D4** · no `svc-chain` on tip             |
| `chain.evm`            | INTAEVM sharing validator set + state                | [chain.evm.md](./chain.evm.md)                       | After mainnet · Tier D                               |
| `chain.validators`     | Validator set opening, published schedule            | [chain.validators.md](./chain.validators.md)         | Shehzad **S-D3** · phase 5P                          |
| `chain.governance`     | Governance parameter handover                        | [chain.governance.md](./chain.governance.md)         | Blocked: validators + `token.governance` **socket**  |
| `launch.token-factory` | ERC-20 deploy from audited templates                 | [launch.token-factory.md](./launch.token-factory.md) | Shehzad **S-A7** · code exists; not audited/done     |
| `launch.launchpad`     | Presale / fair launch, vesting, stake tiers          | [launch.launchpad.md](./launch.launchpad.md)         | No `svc-launch` · stake gates only                   |
| `market.commerce`      | Listings, subscriptions, purchases, house commission | [market.commerce.md](./market.commerce.md)           | Greenfield · dep `market.vendors`                    |
| `venue.aggregation`    | External venue fabric (not CCXT)                     | [venue.aggregation.md](./venue.aggregation.md)       | Public MD partial · trading half not built · M3 risk |

**Pack 5 honesty:** title “via CCXT” on venue is stale (§27 first-party fabric);
token-factory mounted + dev-proven with `audited:false`; `chain.*` has no
`svc-chain` — free research, Shehzad Tier D / S-A7 for implement babysit only.

---

## Pack last6 — ops.support re-freeze (tip `c6d9e89e`)

Five of six “last free heavy” rows landed in **Pack 5** (`chain.*`, `launch.*`,
`market.commerce`). This pack only re-freezes:

| Id            | Title                     | Spec                               |
| ------------- | ------------------------- | ---------------------------------- |
| `ops.support` | Support desk, tickets, KB | [ops.support.md](./ops.support.md) |

Still research only. Not Shehzad M1–M7. No refund ledger invention under this id.

---

## Pack 3 — `docs/trk-research-pack-3` (tip freeze `b3d08931`)

Next free tracker rows **not** covered by pack 1/2 short specs. Research only —
no implement swarm.

| Id                       | Title                                              | Spec                                                     |
| ------------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| `ops.analytics`          | Warehouse — read replica + cube layer              | [ops.analytics.md](./ops.analytics.md)                   |
| `ops.affiliates`         | Multi-tier affiliate / IB trees, payout automation | [ops.affiliates.md](./ops.affiliates.md)                 |
| `agents.scanner`         | Market Scanner — ranked signals by tier            | [agents.scanner.md](./agents.scanner.md)                 |
| `blueprint.ownership`    | Export + hard delete, cascading                    | [blueprint.ownership.md](./blueprint.ownership.md)       |
| `blueprint.attestations` | On-chain rank attestations, zero PII (§19)         | [blueprint.attestations.md](./blueprint.attestations.md) |
| `venue.aggregation`      | External venue fabric (not CCXT)                   | [venue.aggregation.md](./venue.aggregation.md)           |
| `p2p.merchants`          | P2P merchant programme — badges, limits, API       | [p2p.merchants.md](./p2p.merchants.md)                   |
| `indexer.readmodels`     | Chain → Postgres read models                       | [indexer.readmodels.md](./indexer.readmodels.md)         |

**Pack 3 highlights:**

- `blueprint.ownership`: identity cascade **is wired on tip** — tracker note that
  said no subscriber is **stale**; residual is cross-service proof / honesty.
- `venue.aggregation`: title “via CCXT” is stale; fabric is first-party packages.
- `indexer.readmodels`: craft deep; **done** blocked on `socket.clob-contracts`.
- `ops.affiliates`: Class M payout path — recipes only, no ops-local balances.
- `ops.analytics`: do not confuse with bank spend analytics.

---

---

## Pack 5 residual — night cycle3 (`ops.compliance`)

| Id               | Title                              | Spec                                     |
| ---------------- | ---------------------------------- | ---------------------------------------- |
| `ops.compliance` | Screening queues (lists = Class X) | [ops.compliance.md](./ops.compliance.md) |

## Pack 4 — `docs/trk-research-pack-4` (tip freeze re-derive at open)

Academy + agent fleet free rows (status `ready`, no owner). Research only —
**no** `features.mjs` edit; **no** money invention. Shehzad deps noted as
babysit blockers, not agent craft.

| Id                      | Title                                       | Spec                                                   |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `academy.spatial`       | 2D navigable room canvas, VR-ready scene    | [academy.spatial.md](./academy.spatial.md)             |
| `academy.certs`         | Certifications → XP → real perks            | [academy.certs.md](./academy.certs.md)                 |
| `academy.ambassadors`   | Residencies, IFC pay, revenue share         | [academy.ambassadors.md](./academy.ambassadors.md)     |
| `academy.tournaments`   | Seasonal ladders, IFC prize pools           | [academy.tournaments.md](./academy.tournaments.md)     |
| `academy.paper-trading` | Paper-trading market flag for workbooks     | [academy.paper-trading.md](./academy.paper-trading.md) |
| `agents.navigator`      | Navigator — tool-calling in user guardrails | [agents.navigator.md](./agents.navigator.md)           |
| `agents.merchant`       | Merchant agent — approval-rate watch        | [agents.merchant.md](./agents.merchant.md)             |
| `agents.copy-intel`     | Copy-Intel — writes audited leader stats    | [agents.copy-intel.md](./agents.copy-intel.md)         |

**Hard blockers called in specs:** `agents.merchant` → `pay.routing` (shehzad
M1); `agents.copy-intel` → `trade.copy` (shehzad M4); ambassadors/tournaments
prize/pay → ledger recipes + product law (Class M when implemented).

---

## Pack 2 — `docs/trk-research-pack-2` (tip freeze `c773dafa`)

Re-verify + **blueprint.card** add. Same free rows as pack 1 where still
`ready` / unowned, plus Blueprint share-card residual. Prefer these files over
older tip freezes when planning implement.

| Id                   | Title                                          | Spec                                             |
| -------------------- | ---------------------------------------------- | ------------------------------------------------ |
| `ops.admin`          | Operator console — live control plane residual | [ops.admin.md](./ops.admin.md)                   |
| `infra.i18n`         | Surfaces keyed; catalogs beyond English        | [infra.i18n.md](./infra.i18n.md)                 |
| `ops.notifications`  | Out-of-app channels actually deliver           | [ops.notifications.md](./ops.notifications.md)   |
| `ops.support`        | Support desk, tickets, KB                      | [ops.support.md](./ops.support.md)               |
| `agents.support`     | Support agent on gateway runtime               | [agents.support.md](./agents.support.md)         |
| `academy.curriculum` | Full library vs day-one spine                  | [academy.curriculum.md](./academy.curriculum.md) |
| `dex.quote-router`   | Live cross-venue quote or typed refusal        | [dex.quote-router.md](./dex.quote-router.md)     |
| `trade.ccxt-api`     | Bot REST residual (candles, futures toggles)   | [trade.ccxt-api.md](./trade.ccxt-api.md)         |
| `blueprint.card`     | Share card SVG done; PNG rail residual         | [blueprint.card.md](./blueprint.card.md)         |

**Pack 2 deltas vs pack 1:**

- Added `blueprint.card` (SVG compose done; `BLUEPRINT_CARD_RENDERER_URL` rail).
- `trade.ccxt-api`: leverage/margin routes are **typed unsupported**, not absent;
  OHLCV aggregates live fills (materialize job still optional/OFF).
- `ops.admin`: tracker “zero tests / pure useState” note remains **stale** on tip.

---

## Pack 1 — `docs/night-trk-research-pack-1` (merged earlier)

Historical index of first eight free-row specs (same unprefixed filenames). Tip
freeze at open of that branch; pack 2 re-freeze supersedes for implement planning.

| Id                   | Spec                                             |
| -------------------- | ------------------------------------------------ |
| `ops.admin`          | [ops.admin.md](./ops.admin.md)                   |
| `infra.i18n`         | [infra.i18n.md](./infra.i18n.md)                 |
| `ops.notifications`  | [ops.notifications.md](./ops.notifications.md)   |
| `ops.support`        | [ops.support.md](./ops.support.md)               |
| `agents.support`     | [agents.support.md](./agents.support.md)         |
| `academy.curriculum` | [academy.curriculum.md](./academy.curriculum.md) |
| `dex.quote-router`   | [dex.quote-router.md](./dex.quote-router.md)     |
| `trade.ccxt-api`     | [trade.ccxt-api.md](./trade.ccxt-api.md)         |

**Long-form sisters** (ops-packs wave, same ids): `TRK-ops.admin.md`,
`TRK-ops.notifications.md`, `TRK-infra.i18n.md` — deeper stage tables; keep if
useful, do not fork implement plans from conflicting freezes.

---

## Not packed yet (still free, lower priority or heavier blockers)

mining.pool, trade.options/forex, market.vendors (upstream of commerce).
Long-path chain.mainnet / chain.evm / bridge already have **Pack 5** research
files — not “unpacked,” but still blocked for implement.

---

## Pack drain thorough upgrade — `docs/trk-research-pack-drain`

In-place thorough upgrade of free-tracker short-name specs (DoD · tip state ·
doctrine · staged DoD · size · non-goals). No dual `TRK-*` filenames; no
`features.mjs`. Prefer these when planning implement.
