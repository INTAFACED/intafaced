> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# Internet leverage — Phase B full-horizon map (whole future project)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Exchange OSS (2026-08-31) wins on FIX/SBE/Greeks:** [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md) **§0.3** + [`BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md`](BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md). Silence in the tracker table below is **not** permission to hand-roll a FIX parser. `trade.ccxt-api` is a public API **shape**; npm `ccxt` is still **KILL**. `venue.aggregation` = `packages/venue-adapter` decimal strings, not CCXT.

**Status:** CANONICAL · **DONE-DONE** per-ID map (no wildcards)  
**Date:** 2026-08-05 · tip re-derive at write  
**Phase A gate:** PASS — [`INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md`](INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md)  
**Execute / research evidence:** [`INTERNET-LEVERAGE-PHASE-B-EXECUTE-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-EXECUTE-2026-08-05.md) · [`INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-REPORT-V2-2026-08-05.md)  
**Plan:** [`INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md`](INTERNET-LEVERAGE-PHASE-B-PLAN-2026-08-04.md)  
**Methodology:** [`INTERNET-LEVERAGE-METHODOLOGY-AUDIT-2026-08-05.md`](INTERNET-LEVERAGE-METHODOLOGY-AUDIT-2026-08-05.md)

**Term:** Internet leverage = already-built systems we adopt / wire / wrap instead of rebuild.  
**Internal** = Phase A (kit + ledger + services). **External** = EXT rows below.

**Non-regression:** vendor shell = sole product UI · `ledger-client` = only book · no second full exchange kit · no invent mids.

**Completeness claim (this stamp):** every tracker **non-done** row is a **named line** in §2 (not `agents.*` wildcards). Non-tracker gaps/law/security in §3. Count verified at write from `tooling/tracker/features.mjs`.

---

## 0 · Operator one-screen

### Path legend

| Code                 | Meaning                                            |
| -------------------- | -------------------------------------------------- |
| **IN**               | Wire/extend in-repo (prefer first)                 |
| **EXT**              | External OSS/SaaS adopt or trial                   |
| **IN+EXT**           | In-repo service + external adapter                 |
| **GF**               | Greenfield — no good drop-in                       |
| **LAW / LAW→…**      | Denon product law first                            |
| **S**                | Shehzad plane only                                 |
| **X / IN+X / EXT+X** | Class X human (keys, issuers, content, audit hire) |
| **KILL**             | Forbidden (see §5)                                 |

### Phase legend

**NOW** · **MID** · **LATE** · **NEVER** (horizon — not a five-slot thrift queue)

### Tier A start order (decision order only)

1. `FH-SEC-01` ReDoS **split locked** (operator `linear-pattern` · engineer `@intafaced/safe-regex`) · 2. Gitleaks · 3. `G-P0-2` decimals / residual IN · 4. Wallet RPC **critical** (#763) · 5. pay residual IN + Class X acquirer socket (**no Hyperswitch**) · 6. P2P human dispute **built/in-flight**

### Standing order

Prefer **IN** → **EXT** → **GF**. **LAW** blocks invent. **S** = no Nitro L1. **X** = never agent-close. Research map ≠ auto-install.

---

## 1 · Completeness proof (done-done)

| Check                                | Result                                 |
| ------------------------------------ | -------------------------------------- |
| Tracker non-done count at write      | **89**                                 |
| Named rows in §2 for each tracker id | **89 / 89** (script-verified `miss 0`) |
| Wildcard-only coverage               | **None** for tracker ids               |
| Non-tracker Phase A / security / D-S | §3                                     |
| Doctrine non-regression restated     | Header + §5                            |
| Max-5 thrift as ceiling              | **No**                                 |

---

## 2 · Full tracker residual map (every open ID)

Re-derived from `tooling/tracker/features.mjs` where `status ≠ done`.

| ID                                | Status | Title (short)                                                                               | Path          | Phase        | External leverage                                                  | Owner           | Depends           |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------- | ------------- | ------------ | ------------------------------------------------------------------ | --------------- | ----------------- |
| `academy.ambassadors`             | ready  | Residencies, IFC pay, revenue share                                                         | **IN**        | **MID–LATE** | —                                                                  | **N**           | —                 |
| `academy.certs`                   | ready  | Certifications → XP → real perks                                                            | **IN**        | **MID–LATE** | —                                                                  | **N**           | —                 |
| `academy.curriculum`              | ready  | DERIV//DESK library import — 20 playbooks + 3 workbooks                                     | **IN**        | **MID–LATE** | —                                                                  | **N**           | —                 |
| `academy.paper-trading`           | ready  | Paper-trading market flag for workbooks                                                     | **IN**        | **MID–LATE** | —                                                                  | **N**           | —                 |
| `academy.spatial`                 | ready  | 2D navigable room canvas, VR-ready scene state                                              | **IN**        | **MID–LATE** | —                                                                  | **N**           | —                 |
| `academy.tournaments`             | ready  | Seasonal ladders, IFC prize pools                                                           | **IN**        | **MID–LATE** | —                                                                  | **N**           | —                 |
| `agents.copy-intel`               | ready  | Copy-Intel — writes audited leader stats                                                    | **IN**        | **MID–LATE** | —                                                                  | **N**           | guardrails        |
| `agents.merchant`                 | ready  | Merchant agent — approval-rate watch                                                        | **IN**        | **MID–LATE** | —                                                                  | **N**           | guardrails        |
| `agents.navigator`                | ready  | Navigator — tool-calling inside user guardrails                                             | **IN**        | **MID–LATE** | —                                                                  | **N**           | guardrails        |
| `agents.scanner`                  | ready  | Market Scanner — ranked signals by tier                                                     | **IN**        | **MID–LATE** | —                                                                  | **N**           | guardrails        |
| `agents.support`                  | ready  | Support agent — KB + account-state grounded                                                 | **IN**        | **MID–LATE** | —                                                                  | **N**           | guardrails        |
| `bank.cards`                      | ready  | CardIssuerAdapter + card-sim, <2s auth decision                                             | **IN+X**      | **MID**      | Card issuer adapter; live issuer Class X                           | **N + Nitro**   | D-S-09            |
| `bank.ramps`                      | ready  | Fiat on/off ramp reusing svc-pay adapters                                                   | **EXT**       | **MID**      | Moov ACH/Wire/Fed libs + pay adapters; ramp aggregators Class X    | **N**           | D-S-09            |
| `bank.sovereign-card`             | ready  | Self-custody funded card, JIT conversion (§18)                                              | **IN+S**      | **LATE**     | — SA contracts Shehzad                                             | **N/S**         | protocol SA       |
| `blueprint.attestations`          | ready  | On-chain rank attestations, zero PII (§19)                                                  | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `bridge.canonical`                | ready  | Canonical IFC bridge + attestations                                                         | **S**         | **LATE**     | S build + ledger D-S-12 accounting law                             | **S**           | S-D7 + D-S-12     |
| `chain.evm`                       | ready  | INTAEVM sharing validator set + state                                                       | **S**         | **LATE**     | REF: CometBFT / Cosmos SDK / dYdX v4-chain pattern                 | **S**           | S-D0…             |
| `chain.governance`                | ready  | Governance parameter handover                                                               | **S**         | **LATE**     | — S board                                                          | **S**           | S-D0…             |
| `chain.mainnet`                   | ready  | INTACHAIN — CometBFT + native CLOB module                                                   | **S**         | **LATE**     | REF: CometBFT / Cosmos SDK / dYdX v4-chain pattern                 | **S**           | S-D0…             |
| `chain.rust-core`                 | socket | Rust CLOB execution engine                                                                  | **S**         | **LATE**     | REF: CometBFT / Cosmos SDK / dYdX v4-chain pattern                 | **S**           | S-D0…             |
| `chain.validators`                | ready  | Validator set opening, published schedule                                                   | **S**         | **LATE**     | — S board                                                          | **S**           | S-D0…             |
| `dex.quote-router`                | ready  | Live cross-venue quote — real prices or a typed refusal                                     | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `indexer.readmodels`              | ready  | Chain → Postgres read models                                                                | **IN**        | **MID**      | —                                                                  | **N/S**         | chain events      |
| `infra.i18n`                      | ready  | 100+ languages — keyed from day one (§9)                                                    | **IN**        | **MID**      | —                                                                  | **N**           | —                 |
| `launch.launchpad`                | ready  | Presale / fair launch, vesting, staked allocation tiers                                     | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `launch.meme-factory`             | ready  | One-click meme launch + instant market + LP                                                 | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `launch.nft`                      | ready  | NFT mint / list / auction, on-chain royalties                                               | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `launch.rwa`                      | socket | RWA issuance registry, licence-gated                                                        | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `launch.token-factory`            | ready  | ERC-20 deploy from audited templates                                                        | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `market.commerce`                 | ready  | Listings, subscriptions, purchases, house commission                                        | **IN**        | **MID–LATE** | —                                                                  | **N**           | —                 |
| `market.vendors`                  | ready  | Vendor lifecycle — apply, vet, list, stake-gated slots                                      | **IN**        | **MID–LATE** | —                                                                  | **N**           | —                 |
| `mining.pool`                     | ready  | Stratum share protocol, PPLNS payouts                                                       | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `ops.admin`                       | ready  | apps/admin — listings, fee params, treasury, kill-switch                                    | **IN**        | **MID**      | —                                                                  | **N/D**         | —                 |
| `ops.affiliates`                  | ready  | Multi-tier affiliate / IB trees, payout automation                                          | **GF**        | **MID**      | — no drop-in                                                       | **N**           | —                 |
| `ops.analytics`                   | ready  | Warehouse — read replica + cube layer                                                       | **EXT**       | **LATE**     | ClickHouse/cube when funded                                        | **N/D**         | —                 |
| `ops.compliance`                  | ready  | Screening queues, geo-block, VPN/Tor detection                                              | **IN+X**      | **MID**      | Screening queues IN; list content Class X                          | **N + Nitro**   | —                 |
| `ops.notifications`               | ready  | Event-driven fan-out: in-app, push, email, SMS                                              | **IN**        | **MID**      | —                                                                  | **N**           | —                 |
| `ops.support`                     | ready  | Support desk, tickets, KB                                                                   | **IN**        | **MID**      | —                                                                  | **N**           | —                 |
| `p2p.merchants`                   | ready  | P2P merchant programme — badges, limits, API                                                | **IN**        | **MID**      | —                                                                  | **N**           | D-S-08            |
| `pay.fraud`                       | ready  | Risk scoring, chargebacks, decline recovery                                                 | **EXT**       | **LATE**     | PSP fraud tools as adapters — not second book                      | **N**           | pay live          |
| `pay.gateway`                     | wip    | Branded gateway, hosted checkout, payment links                                             | **IN+X**      | **MID**      | Commercial acquirer / partner — **not** Hyperswitch (D-S-10 #769)  | **N + Nitro**   | D-S-10            |
| `pay.payfac`                      | ready  | PayFac mode — sub-merchant trees, 14 permission areas                                       | **LAW→IN/GF** | **MID**      | — after law                                                        | **N after D**   | D-S-10            |
| `pay.plugins`                     | ready  | Woo / Magento / OpenCart plugins                                                            | **GF**        | **LATE**     | — no drop-in                                                       | **N**           | pay.public-api    |
| `pay.psp`                         | ready  | PSP mode — own the merchant, digital KYB, custom pricing                                    | **IN+X**      | **MID**      | Commercial relationship — **not** Hyperswitch (D-S-10 #769)        | **N + Nitro**   | D-S-10            |
| `pay.public-api`                  | ready  | Public REST + webhooks + sandbox (§9)                                                       | **IN**        | **MID**      | —                                                                  | **N**           | —                 |
| `pay.routing`                     | ready  | Smart routing — geo, method, risk, approval rate                                            | **IN+X**      | **MID**      | Our routing + relationship-backed connectors; **Hyperswitch KILL** | **N + Nitro**   | D-S-10 ADR #769   |
| `pay.settlement`                  | ready  | Dual settlement — bank or crypto                                                            | **IN**        | **MID**      | —                                                                  | **N**           | ledger            |
| `pay.subscriptions`               | ready  | Recurring — card and crypto                                                                 | **IN**        | **LATE**     | —                                                                  | **N**           | card rail         |
| `protocol.amm`                    | ready  | AMM pools from audited templates                                                            | **S**         | **MID–LATE** | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `protocol.escrow`                 | ready  | Non-custodial P2P escrow contracts                                                          | **S**         | **MID–LATE** | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `protocol.lending`                | ready  | On-chain lending markets, keeper liquidations                                               | **S**         | **MID–LATE** | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `protocol.merchant`               | ready  | Lane A merchant contracts — zero KYB (§24)                                                  | **S**         | **MID–LATE** | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `protocol.router`                 | ready  | Sovereign router — book vs pool best execution                                              | **S**         | **MID–LATE** | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `protocol.smart-accounts`         | ready  | Passkey smart accounts, session keys (§17.4)                                                | **S**         | **MID–LATE** | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.clob-contracts`           | socket | An audited venue contract emitting the indexed event sur                                    | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.contract-audit`           | socket | External audit of the account + factory suite                                               | **X**         | **LATE**     | Class X human pick                                                 | **Nitro**       | Class X           |
| `socket.contract-toolchain`       | socket | Foundry + contract test suite in CI                                                         | **S**         | **MID**      | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.dex-execution`            | socket | Order execution against a quoted venue (§27 vault, §28 O                                    | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.dex-fee-source`           | socket | Authoritative per-venue fee and settlement schedule                                         | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.dex-venue-set`            | socket | A venue this platform actually quotes                                                       | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.geo-region-resolution`    | socket | Resolve the caller’s region per request instead of stamp                                    | **EXT**       | **LATE**     | Geo provider adapter                                               | **N**           | —                 |
| `socket.indexer-stream`           | socket | Live book/tape feed from the projection (§5.2 ws-gateway                                    | **IN**        | **LATE**     | —                                                                  | **N/S**         | indexer           |
| `socket.ledger-sharding`          | socket | Per-asset hash chains with cross-shard anchor                                               | **GF**        | **LATE**     | — no drop-in                                                       | **D/N**         | —                 |
| `socket.live-issuer`              | socket | Live card issuer rail                                                                       | **X**         | **LATE**     | Class X human pick                                                 | **Nitro**       | Class X           |
| `socket.mpc-custody`              | socket | MPC custody for self-custody wallets                                                        | **EXT**       | **LATE**     | DFNS/Turnkey-class after wallet RPC review                         | **D→N + Nitro** | G-P1-4 review     |
| `socket.notify-email`             | socket | Email notification channel                                                                  | **EXT**       | **MID**      | SES/etc behind svc-notify                                          | **N**           | —                 |
| `socket.notify-push`              | socket | Push notification channel (device tokens + provider)                                        | **EXT**       | **MID**      | FCM/APNs SDK behind svc-notify                                     | **N**           | —                 |
| `socket.notify-sms`               | socket | SMS notification channel                                                                    | **EXT**       | **LATE**     | Twilio-class behind svc-notify                                     | **N**           | —                 |
| `socket.p256-verifier`            | socket | Passkey (P-256) owner verifier contract                                                     | **S**         | **MID**      | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.psp-partners`             | socket | PayPal / Stripe / live acquiring rails                                                      | **X**         | **LATE**     | Class X human pick                                                 | **Nitro**       | Class X           |
| `socket.rust-matching`            | socket | Rust port of svc-matching                                                                   | **LAW→S/D**   | **LATE**     | Study only; dual-target D-S-06                                     | **D/S**         | §13 / product yes |
| `socket.social-recovery`          | socket | Guardian-based account recovery                                                             | **S**         | **LATE**     | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.stream-provider`          | socket | A real WebRTC SFU behind StreamProvider (§8.3 LiveKit se                                    | **EXT**       | **LATE**     | WebRTC SFU adapter                                                 | **N**           | —                 |
| `socket.userop-differential-test` | socket | getUserOperationHash checked against a live EntryPoint                                      | **S**         | **MID**      | — (Shehzad plane)                                                  | **S**           | S-D0…             |
| `socket.vr-client`                | socket | VR lobby client                                                                             | **GF**        | **LATE**     | — no drop-in                                                       | **N**           | —                 |
| `token.buyback`                   | socket | Operator-recorded burn (no buyback — nothing is bought)                                     | **GF**        | **MID**      | — no drop-in                                                       | **N**           | D-S-14            |
| `token.governance`                | socket | Proposals + IFC-weighted ballots — outcome NOT built (§4                                    | **GF**        | **MID**      | — no drop-in                                                       | **N**           | D-S-14            |
| `token.yield`                     | socket | Operator-settled staker payout (§4.3 weekly job NOT buil                                    | **GF**        | **MID**      | — no drop-in                                                       | **N**           | D-S-14            |
| `trade.algo`                      | ready  | TWAP / VWAP / POV execution                                                                 | **LAW→IN/GF** | **MID**      | — after law                                                        | **N after D**   | D-S-04            |
| `trade.ccxt-api`                  | ready  | CCXT-**shaped** public API (bots connect). **Not** npm `ccxt`.                              | **IN**        | **MID**      | — (own contracts; JS `number` still banned)                        | **N**           | doctrine          |
| `trade.copy`                      | ready  | Copy trading, audited leaders, profit share                                                 | **LAW→IN/GF** | **MID**      | — after law                                                        | **N after D**   | D-S-03            |
| `trade.forex`                     | ready  | Fiat pairs on the same engine                                                               | **LAW→IN/GF** | **MID**      | — after law                                                        | **N after D**   | D-S-05            |
| `trade.futures`                   | ready  | Perps: cross/isolated margin, funding, liquidation ladde                                    | **LAW→IN/GF** | **MID**      | — after law                                                        | **N after D**   | D-S-01            |
| `trade.mm-bot`                    | ready  | Internal market-maker seeding books at launch                                               | **IN**        | **MID**      | —                                                                  | **N**           | —                 |
| `trade.options`                   | ready  | European options, cash-settled, full collateral in v1                                       | **LAW→IN/GF** | **MID**      | — after law                                                        | **N after D**   | D-S-01/05         |
| `trade.otc`                       | ready  | OTC RFQ desk, staked-tier gate                                                              | **LAW→IN/GF** | **MID**      | — after law                                                        | **N after D**   | D-S-02            |
| `venue.aggregation`               | ready  | Cross-venue adapters via `packages/venue-adapter` (decimal strings). npm `ccxt` = **KILL**. | **IN**        | **LATE**     | —                                                                  | **N**           | D-S-05            |
| `web.terminal`                    | wip    | Pro terminal — depth, charts, hotkeys, sub-accounts                                         | **IN**        | **NOW**      | —                                                                  | **N**           | S-WS              |
| `ws.gateway`                      | wip    | WebSocket fan-out: depth, trades, orders, positions                                         | **IN**        | **MID**      | —                                                                  | **N**           | D-S-01            |

### Non-tracker rows (Phase A gaps + law + security — still in scope)

| ID                | Need                                        | Path       | Phase        | External                                                                                                                                  | Owner         | Depends                     |
| ----------------- | ------------------------------------------- | ---------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- |
| `G-P0-1`          | Depth E2E (**proven** Denon 2026-08-05)     | **IN**     | **DONE**     | — (fleet image trap was real; rebuild from tip)                                                                                           | **N/D**       | closed                      |
| `G-P0-2`          | Decimal desk bignumber E2E                  | **IN**     | **NOW**      | —                                                                                                                                         | **N**         | —                           |
| `G-P0-3`          | Pay residual after #346                     | **IN+X**   | **MID**      | Class X acquirer socket; no Hyperswitch                                                                                                   | **N**         | handoff + D-S-10            |
| `G-P0-4`          | Denon open work (#428)                      | **IN**     | **NOW**      | —                                                                                                                                         | **D**         | his PR                      |
| `G-P0-5`          | Engine product law                          | **LAW**    | **NOW**      | —                                                                                                                                         | **D**         | D-S-01…05                   |
| `G-P1-1`          | OTC/admin/CMS kit path                      | **IN**     | **MID**      | —                                                                                                                                         | **N**         | law                         |
| `G-P1-2`          | V-ADMIN primary ops                         | **IN**     | **MID**      | —                                                                                                                                         | **N/D**       | —                           |
| `G-P1-4`          | Wallet RPC **critical defects**             | **IN**     | **NOW**      | Fix #763 freezes (mainnet dual-broadcast class) before MPC                                                                                | **D→N**       | #763                        |
| `G-P1-5`          | Wire ops.support ↔ svc-support              | **IN**     | **MID**      | —                                                                                                                                         | **N**         | —                           |
| `G-P2-2`          | spine-* disposition                         | **IN**     | **MID**      | —                                                                                                                                         | **D**         | —                           |
| `FH-SEC-01`       | ReDoS-safe parsers                          | **IN/EXT** | **NOW**      | **Split locked:** operator patterns → `linear-pattern`; engineer parsers → `@intafaced/safe-regex` (re2js); no native node-re2            | **N/D**       | Law §3.2 · Nitro 2026-08-05 |
| `FH-SEC-02`       | Secret scanning CI                          | **EXT**    | **NOW**      | Gitleaks                                                                                                                                  | **N**         | —                           |
| `FH-SEC-04`       | Money SAST                                  | **EXT**    | **MID**      | Semgrep patterns                                                                                                                          | **N**         | —                           |
| `FH-SEC-05`       | Property tests money                        | **EXT**    | **MID**      | fast-check                                                                                                                                | **N**         | Class M                     |
| `FH-SEC-06`       | Chaos network trade↔match                   | **EXT**    | **LATE**     | Toxiproxy                                                                                                                                 | **D/N**       | —                           |
| `FH-UI-01`        | Runtime edge validation                     | **IN**     | **MID**      | **Zod 3 already in-repo — KEEP.** Do not trial Valibot or silent-upgrade Zod 4. OpenAPI-from-Zod = `@asteasolutions/zod-to-openapi@7.3.4` | **N**         | north-star §0.3             |
| `FH-P2P-D`        | Human dispute desk                          | **IN**     | **NOW**      | **Built/in-flight** (not GF); Kleros still KILL Fiat                                                                                      | **N/D**       | D-S-08                      |
| `FH-ID-01`        | Passkeys                                    | **EXT**    | **MID**      | SimpleWebAuthn (`@simplewebauthn/server`)                                                                                                 | **N**         | D-S-11 · §0.3               |
| `PTX-FIX`         | FIX session / drop copy (`PTX-M05-R02/R10`) | **EXT**    | **LATE**     | **QuickFIX/J 3.0.2** adapter. Fills → matching → ledger. Not leftover IN queue.                                                           | **N**         | north-star §0.3             |
| `PTX-SBE`         | Binary SBE codec (`PTX-M05-R04`)            | **EXT**    | **LATE**     | **Real Logic SBE 1.39.0** + our schema. Not a matching engine.                                                                            | **N**         | north-star §0.3             |
| `PTX-QL`          | Options Greeks / calendars (`PTX-M11`)      | **EXT**    | **LATE**     | **QuantLib 1.43** C++ adapter. Decimal strings out. Not the money book. Not live mark SoT.                                                | **N**         | north-star §0.3             |
| `FH-ID-02`        | KYC providers                               | **EXT+X**  | **MID–LATE** | Sumsub/Persona/… adapters                                                                                                                 | **N + Nitro** | Class X                     |
| `D-S-01`…`D-S-18` | Spec factory                                | **LAW**    | **NOW**      | — mandate kit+ledger                                                                                                                      | **D**         | —                           |
| `V-MOBILE`        | Mobile apps                                 | **GF**     | **LATE**     | Expo/RN or Flutter when product yes                                                                                                       | **N**         | product                     |

---

## 3 · How to re-verify (anti-bullshit)

```bash
node -e "
const {FEATURES}=require('./tooling/tracker/features.mjs');
const open=FEATURES.filter(x=>x.status&&x.status!=='done');
const doc=require('fs').readFileSync('docs/INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md','utf8');
const miss=open.filter(x=>!doc.includes('\`'+x.id+'\`'));
console.log('open', open.length, 'missing', miss.length, miss.map(x=>x.id));
"
```

Expect: `missing 0`.

---

## 4 · External shortlist (where Path contains EXT) — deep evidence in v2

> **Corrected 2026-08-06 — read [`INTERNET-LEVERAGE-PHASE-C-GATEWAY-SOCKETS-2026-08-06.md`](INTERNET-LEVERAGE-PHASE-C-GATEWAY-SOCKETS-2026-08-06.md) before acting on the notify or MPC rows.**
> `svc-notify` and `svc-agents` terminate at operator-set URLs and name no vendor below the adapter (§0.7). Installing the SDKs this table lists would put a vendor name in source and re-couple provider choice to a release — the exact property those files were written to have. The capability rows are right; what you install to get them is not. Phase C also adds two rows this table has no line for: supply-chain scanning and a perf harness.

| External                                           | Used by IDs / FH rows             | Action                                                                                      |
| -------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `linear-pattern` + `@intafaced/safe-regex` (re2js) | FH-SEC-01, P2P operator patterns  | **Split:** operator → linear-pattern; engineer → safe-regex; ban native node-re2 (law §3.2) |
| Gitleaks                                           | FH-SEC-02                         | **Adopt NOW**                                                                               |
| Hyperswitch                                        | pay.routing, pay.gateway, pay.psp | **KILL** — D-S-10 ADR #769                                                                  |
| Moov ACH/Wire/Fed                                  | bank.ramps                        | **Adapt MID**                                                                               |
| SimpleWebAuthn                                     | FH-ID-01                          | **Trial MID**                                                                               |
| QuickFIX/J 3.0.2                                   | PTX-FIX                           | **Adapter when FIX mountain is on** — not leftover IN queue                                 |
| Real Logic SBE 1.39.0                              | PTX-SBE                           | **Codec + our schema** when binary feed is on                                               |
| QuantLib 1.43                                      | PTX-QL                            | **Greeks/calendar adapter** — decimal out; not the book                                     |
| `@asteasolutions/zod-to-openapi@7.3.4`             | FH-UI-01 / PTX-M05-R08            | **Zod 3 pin.** Do not jump to generator 9.x / Zod 4 in the same PR                          |
| KYC SaaS adapters                                  | FH-ID-02                          | **Later + X**                                                                               |
| SES/Twilio/FCM/APNs                                | notify sockets                    | **Adapt MID–LATE**                                                                          |
| Zod 3 (in-repo KEEP)                               | FH-UI-01                          | **Already in stack.** Do not trial Valibot / silent Zod 4                                   |
| fast-check                                         | FH-SEC-05                         | **Adopt MID**                                                                               |
| Toxiproxy                                          | FH-SEC-06                         | **Later**                                                                                   |
| Semgrep                                            | FH-SEC-04                         | **Later**                                                                                   |
| DFNS / Turnkey                                     | socket.mpc-custody                | **Later after review + X**                                                                  |
| ClickHouse/cube                                    | ops.analytics                     | **Later**                                                                                   |
| Meilisearch/Typesense                              | ops.admin search residual         | **Later** if needed                                                                         |
| Expo/RN or Flutter                                 | V-MOBILE                          | **Later** product yes                                                                       |
| CometBFT / Cosmos / dYdX v4                        | chain.*                           | **REF S only**                                                                              |
| WebRTC SFU                                         | socket.stream-provider            | **Later**                                                                                   |

Detail (license, stars, doctrine): see Phase B REPORT v2.

---

## 4b · Isolation (not path dual-edit alone)

**Dedicated test database per branch** when suites migrate at startup. Shared Postgres contaminates peer worktrees (Denon #428 A/B).

## 5 · Kill / never (do not “helpfully” reopen)

| Kill                                                  | Why                           |
| ----------------------------------------------------- | ----------------------------- |
| Second full exchange UI kit                           | Phase A non-regression        |
| Second ledger SoT (Formance/TigerBeetle/Blnk as book) | Doctrine                      |
| Invent mids / oracle as match truth                   | Honesty                       |
| Kleros / AI as Fiat dispute adjudicator               | Human ruling + custody escrow |
| CCXT on money path                                    | Floats + doctrine             |
| exchange-core as Fiat matching replace                | Unmaintained + doctrine split |
| Hot-wallet random npm                                 | Custody supply chain          |
| Nitro implements Shehzad L1 core                      | Ownership                     |
| Dual-edit Denon/Shehzad open PR files                 | Collision                     |
| Partner names in user-facing copy                     | Brand — adapters only         |

---

## 6 · Non-claims

- Not implement / not npm install.
- Not every EXT row re-researched this stamp — shortlist evidence in v2; per-ID path assignment is complete.
- Not “platform shipped.”

---

_Board-Delta: Phase B full-horizon DONE-DONE — 89/89 tracker IDs named rows + non-tracker appendix_
