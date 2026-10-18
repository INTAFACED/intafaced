# Spec — Pro Exchange competitive delta (31 August 2026)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative addendum. Does not replace any `PX-S*`.  
**Parent:** [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md) v1.20  
**Research cutoff:** 31 August 2026  
**Scope:** backend only. M07 out.

This file exists so Grok bot does not treat 2026 venue behavior as “just another perp” or invent HIP-3 / yield-on-margin / FIX 5.0 by cloning.

## What changed in the landscape (and is now law here)

| Observed 2026 pattern                                                | Spec consequence                                                  | Not this                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| Equity / commodity / metal perps (HIP-3, xStocks, gold/silver books) | `PTX-M02-R07` — underlying class is a product                     | Do not list as a crypto perp                       |
| Builder-deployed permissionless markets                              | `PTX-M02-R08` — not implied; separate consented product or refuse | Do not clone HIP-3 onto a regulated CEX by default |
| Yield-bearing / staked / idle-lend collateral                        | `PTX-M08-R11` — separate product with slash/unbond/recall         | Do not treat yield as free money on posted margin  |
| Deribit 2×2 margin (segregated/cross × standard/PM)                  | `PTX-M08-R10`                                                     | Do not hide as a UI flag                           |
| CME in-flight mitigation                                             | `PTX-M03-R09`                                                     | Do not double-live an amend                        |
| Deribit two-sided mass-quote reject + MQQ margin reserve             | `PTX-M11-R11`, `R12`                                              | Owner MMP numbers stay unset-refuse                |
| Coinbase Prime FIX 5.0; Kraken FIX 4.4                               | `PTX-M05-R10`                                                     | “FIX exists” is not a version                      |
| Kraken off-book RFQ max-leverage (20 Aug 2026)                       | `PTX-M12-R09`                                                     | Book schedule does not apply to RFQ                |
| Public LP attribution / “L4”                                         | `PTX-M06-R11`                                                     | Do not infer from L2                               |
| CME Globex credit controls                                           | `PTX-M09-R10`                                                     | Unset dimensions refuse; no invented flatten       |

## Child mapping (amend these PX-S contracts; do not recook them)

| New R-item           | Amends                            |
| -------------------- | --------------------------------- |
| `PTX-M02-R07`, `R08` | PX-S01 rulebook / lifecycle       |
| `PTX-M03-R09`        | PX-S03 microstructure / execution |
| `PTX-M05-R10`        | PX-S04 connectivity               |
| `PTX-M06-R11`        | PX-S04 data                       |
| `PTX-M08-R10`, `R11` | PX-S06 collateral / risk          |
| `PTX-M09-R10`        | PX-S06                            |
| `PTX-M11-R11`, `R12` | PX-S08 options / MMP              |
| `PTX-M12-R09`        | PX-S09 RFQ / block                |

## Hard stops (unchanged)

One money book. Decimal strings. No invented owner magnitudes. Unsupported class/version/cap **refuses**. Frontend is not this addendum.
