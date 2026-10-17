# Owner decision packet, part two — P0-04…17 + completeness home

**Status:** Remaining **Denon** P0 product rulings sealed 2026-08-14 (`adr/2026-08-14-remaining-p0-money-law.md`). Class X / F10 / GitHub admin / token **magnitudes** stay Nitro.  
**Board:** `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` **D26-P0-04…17** (P0-18 = this packet family).  
**Companion (part one):** [`OWNER-DECISION-PACKET-2026-08-09.md`](OWNER-DECISION-PACKET-2026-08-09.md) — P0-01…03 plus money-path / dark-feed / token magnitudes / F10.  
**Machine index (tip SoT for “what is still open”):** [`ops/owner-ruling-packet.json`](ops/owner-ruling-packet.json).

**Rule carried from part one:** a missing number is **refuse-closed**, never a placeholder. Agents implement mechanisms and refuse paths. Denon takes recommendations in this packet; Nitro does **not** gate Denon mountains. Class X (secrets, go-live, licence, sanctions list content) stays Nitro.

---

## Completeness (D26-P0-18)

Part one started the sitting. Part two was a stub. **As of 2026-08-12 the tip packet is complete when:**

1. Part one + this file cover every **D26-P0-01…17** product ruling (sealed or open).
2. [`ops/owner-ruling-packet.json`](ops/owner-ruling-packet.json) indexes those rows **plus** Class X / admin / payout satellites that were previously only in side checklists.
3. A new owner decision that is not in the JSON is a **gap** — add a row before inventing product law.

P0-18 itself is the meta-seal for that tracking, not a product number.

---

## P0-04 · Token emission / buyback authority live

**Blocks:** burn / claim paths that trust seeds over the authority store; agents inventing drift guards.  
**Settled:** [`adr/2026-08-04-token-economics-outcomes.md`](adr/2026-08-04-token-economics-outcomes.md) — **whose** the numbers are (owner), deliberately **no** magnitudes.  
**Question:** when does the live authority store become the only source, and what fails closed if seeds ≠ DB?  
**Recommendation:** claim-before-burn + drift refuse until the store is populated; never burn on seed alone.  
**Also see:** part one item 9 (four token numbers) and index `PKT-C9`.

---

## P0-05 · Options / forex settlement asset law

**Status:** **SEALED freeze 2026-08-15** — [`docs/adr/2026-08-13-options-forex-settlement-asset-law.md`](adr/2026-08-13-options-forex-settlement-asset-law.md).  
**Blocks:** `trade.options`, `trade.forex` product-complete paths (still).  
**Settled:** (1) live instrument set = **empty** until a later owner stamp; (2) settlement asset = **unset**; (3) empty/unset → named refuse. Opaque `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` stays empty under this freeze and is never a parsed coin table. T6 already refuse-closes options listing. Forex production waits on **true fiat rails** (euro-stable ≠ rails).  
**Refuse when unset:** `trade.options_settlement_law_unset` · `trade.options_fixing_unconfigured` · `trade.options_terms_incomplete` · `trade.market_kind_unsupported` (orders) · `trade.unsettled_asset_class_listing` (FX/commodity production).  
**Not invented here:** USDT/USDC/USD/IFC/quote-as-cash, FX pair list, D7 fixing content, bank rails. This freeze does **not** authorize a host stamp.

---

## P0-06 · Listing / delisting policy (DIRECTION §8.5)

**Blocks:** agents listing markets because a form exists.  
**Question:** what may list, who may list it, what delists, and what the refuse path returns when policy is blank?  
**Recommendation:** written policy that ends in a named refuse code; blank policy = no list, not “default allow.”

---

## P0-07 · Leverage / margin / liq params beyond §1 defaults

**Status:** **SEALED 2026-08-13** — [`docs/adr/2026-08-13-leverage-defaults-frozen.md`](adr/2026-08-13-leverage-defaults-frozen.md).  
**Not open:** `DEFAULT_MAX_LEVERAGE = 10` — DIRECTION §1, now frozen as the live table. Isolated v1; partial-before-full.  
**Still owner-open:** any raise above 10×, D3 ladder _numbers_, market-level overrides, cross-margin (own ADR).  
**Settled:** silent constant edits are doctrine crime. The freeze is the ruling until an owner table exists.

---

## P0-08 · `pay:write` / KYB grant mechanism shape

**Status:** **SEALED 2026-08-13 (D26-P0-08)** — [`adr/2026-08-13-pay-write-grant-a2-unpublished.md`](adr/2026-08-13-pay-write-grant-a2-unpublished.md) (amends 2026-08-12 shape).  
**Blocks:** production merchants authenticating via granted `pay:*` until Nitro publishes A2.  
**Ruling:** A2 unpublished = `auth.merchant_pay_scope_grant_unpublished`. Agents do not invent a grantor. Layer B KYB money gate is not a grant. `issueMerchantPayScopes` stays refuse.

---

## P0-09 · Fee + revenue recipe map

**Status:** **SEALED 2026-08-15 (D26-P0-09)** — [`adr/2026-08-15-d26-p0-09-fee-revenue-recipe-map.md`](adr/2026-08-15-d26-p0-09-fee-revenue-recipe-map.md).  
**Blocks:** agents adding ledger recipes because a fee path “needs one.”  
**Still no default:** part one item 5 — `TRADE_FUTURES_PROFIT_SOURCE` has **no compose default** (index `PKT-B5`). Recipe `futuresRealizeProfit` exists; empty host still refuses.  
**Closed matrix:** every fee/revenue path → named recipe or explicit §13. Live inventory is D26-P2-11 **#1745** (`packages/ledger-client` `live-path-inventory.ts`) — this packet does not duplicate it and does not invent recipes. New recipes require an owner carve-out on this row.

---

## P0-10 · Listings / treasury / house commission law

**Status:** **SEALED 2026-08-13 (D26-P0-10)** — [`adr/2026-08-13-house-commission-authority.md`](adr/2026-08-13-house-commission-authority.md).  
**Blocks:** nothing on mechanism; **P0-02** still owns the bps.  
**Ruling:** authority is host `MARKET_HOUSE_COMMISSION_BPS` (no in-repo default). Blank is `market.commission_not_configured`. Explicit `0` is owner free-commission. House cut only via `marketPurchase` → `houseFees(market)`. Agents do not seed a rate.

---

## P0-11 · Scanner signal inputs law

**Blocks:** `agents.scanner` ranked signals.  
**Question:** which inputs may enter a rank, and what refuses when inputs are missing or untrusted?  
**Recommendation:** written input allow-list + fail-closed when any required input is absent. Rankings without law are product invention.

---

## P0-12 · Attestation threat model (`blueprint.attestations`)

**Status:** **Sealed 2026-08-15.** Dedicated threat model: [`THREAT-MODEL-BLUEPRINT-ATTESTATIONS.md`](THREAT-MODEL-BLUEPRINT-ATTESTATIONS.md).  
**Blocks:** on-chain rank / attestation surfaces until the zero-PII bar is met. On-chain implement stays Shehzad (`protocol.smart-accounts`).  
**Question:** threat model + zero-PII bar before any product path claims Done.  
**Ruling:** an attestation may prove discrete rank/standing for a named epoch. It must never contain identity, KYC, or addresses that link Fiat and Protocol planes. Implementers refuse if the bar is unmet. No PII in attestation payloads. Product `done` for `blueprint.attestations` stays refused until a verifier meets the bar.

---

## P0-13 · Launchpad raise economics (law only)

**Blocks:** raise economics numbers invent.  
**Ownership:** law = owner/Denon; **on-chain implement = Shehzad** (agents babysit only).  
**Question:** which economic parameters are law vs socket, and what refuses until set?  
**Recommendation:** law doc with named params or explicit refuse; never ship agent-invented raise math.

---

## P0-14 · `DEFAULT_MIN_BEST_LEVEL_*` + mark dust floor

**Status:** **SEALED 2026-08-13** — [`docs/adr/2026-08-13-mark-dust-floor.md`](adr/2026-08-13-mark-dust-floor.md).  
**Covered in part one item 4.** Keep shipped `'100'` + 100 bps until a real market lists with observed depth. Ties P0-01 Q3 (no inventing a second % cap).

---

## P0-15 · Copy jurisdiction list

**Status:** **SEALED 2026-08-15** — refuse-closed in all regions until a counsel-supplied list exists. No agent-authored country table. ADR: [`adr/2026-08-15-copy-jurisdiction-refuse-closed.md`](adr/2026-08-15-copy-jurisdiction-refuse-closed.md). List content remains `CLASS-X-SANCTIONS`.  
**Covered in part one item 3 table** — same refuse-closed shape as copy fee-share (`COPY_FEE_SHARE_RESIDUAL`): unset is a closed door, not a guessed ISO table. Engineers never draft the list.

---

## P0-16 · “Audited / insured / guaranteed” language ban

**Blocks:** marketing invent under DIRECTION §8.9.  
**Question:** which product surfaces may use those words, and what gate requires an owner seal?  
**Recommendation:** product copy + automated gate — those words require owner seal; default ban in user-facing copy.

---

## P0-17 · Insurance fund funding policy (futures list gate)

**Status:** **SEALED 2026-08-13** — [`docs/adr/2026-08-13-insurance-fund-funding-policy.md`](adr/2026-08-13-insurance-fund-funding-policy.md).  
**Blocks:** listing live perps against an empty or undefined fund (still, until the pot is actually funded on that deploy).  
**Settled:** ledger insurance account exists; `futuresInsuranceTopup` funds it; `trade.insurance_fund_empty` refuses real-money active futures while `available ≤ 0`; house fees are not the fund; paper/pending may model.  
**Not invented here:** target size, fee-share, capitalisation schedule.

---

## Satellites (indexed, not re-litigated here)

| Index id                             | Home doc                                                                                         | Why separate                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `PAYOUT-01`                          | [`OWNER-RULINGS-FROM-DENON-PAYOUT-2026-08-09.md`](OWNER-RULINGS-FROM-DENON-PAYOUT-2026-08-09.md) | Affiliate payout clicks / defaults |
| `CLASS-X-NOTIFY`                     | [`OWNER-ACTIONS-NOTIFY-GATEWAYS.md`](OWNER-ACTIONS-NOTIFY-GATEWAYS.md)                           | Out-of-app delivery credentials    |
| `CLASS-X-WALLET-SECRETS` / `PKT-D10` | [`OWNER-ACTIONS-WALLET-RPC-SECRETS.md`](OWNER-ACTIONS-WALLET-RPC-SECRETS.md)                     | Rotation + §A4 F10                 |
| `CLASS-X-SANCTIONS`                  | [`OWNER-DECISIONS-OPEN.md`](OWNER-DECISIONS-OPEN.md)                                             | Counsel list content               |
| `CLASS-X-LICENCE`                    | [`LICENCE-POSITION.md`](LICENCE-POSITION.md)                                                     | Counsel / launch lawfulness        |
| `CLASS-X-GO-LIVE`                    | staging deploy ADR                                                                               | Host / secrets / prod RPC          |
| `GH-G1`…`G5`                         | [`ops/OWNER-GITHUB-CONFIG.md`](ops/OWNER-GITHUB-CONFIG.md)                                       | Admin-only GitHub settings         |

---

## What to answer next (aligned with part one)

Denon P0 product law for custodial engines is sealed (2026-08-14). Remaining clicks are **not** agent-wait:

1. **Nitro Class X** — gateway credentials, wallet rotation, licences, go-live, sanctions **content**.
2. **PKT-C9 magnitudes** — emission/buyback/burn/staking into `token_params` when those surfaces should go live.
3. **PKT-D10 F10** — human edit in unreviewed Java (`act/pom.xml`). Denon will not touch it.
4. **Shehzad** — INTACHAIN / attestations against the P0-12 bar / launchpad chain.
5. **GitHub admin** — GH-G1…G3, G5.
