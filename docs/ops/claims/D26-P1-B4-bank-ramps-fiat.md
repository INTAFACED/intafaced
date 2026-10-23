# Claim — D26-P1-B4 bank.ramps fiat via pay adapters

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

| Field        | Value                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| ID           | D26-P1-B4                                                                                   |
| Tracker      | `bank.ramps`                                                                                |
| Branch       | `feat/bank-ramps-fiat-pay-adapters`                                                         |
| Owner        | Phantom-X-007 (Denon agent)                                                                 |
| Paths        | `services/svc-bank/src/ramps/**` · LIVE-LANES · features.mjs                                |
| Do not touch | `bank.auto-invest` · `bank.business` · invent APY/card BIN · `packages/ledger-client` edits |
| Note         | COMPLETE: public-door fiat on/off via PayFiatRampPort; ledger-only; crypto half #997        |

Claimed 2026-08-12. Crash recovery of prior WIP on `feat/bank-ramps-fiat-honesty`.
Fattened 2026-08-12: `ramps-fiat-product.test.ts` seals mounted-router E2E (empty/sandbox refuse + live pay rail money path).
