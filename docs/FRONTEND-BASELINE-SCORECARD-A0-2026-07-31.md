# Baseline scorecard — A0 (first eyes)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-07-31  
**Tip base at boot:** see PR #267 branch · shell http://127.0.0.1:8090  
**Eyes:** Orca embedded browser  
**Method:** gates 4 / 11 / 12 must not fail; others 0–3 (Design Bar)

## Surfaces scored

| Surface               | Gate 4 Honesty                    | Gate 11 Feed truth  | Gate 12 Irreversible friction             | Notes                  |
| --------------------- | --------------------------------- | ------------------- | ----------------------------------------- | ---------------------- |
| `/exchange` desk      | 2 → **target 3** after #267 stack | 2 (No feed labeled) | 2 (ticket lock exists; cancel now locked) | Chart attr added A0.5  |
| `uc/money` MoneyIndex | 3 (dialect 2 already)             | n/a                 | n/a                                       | Dual-book note present |
| `uc/withdraw`         | **3** after A2′ on stack          | n/a                 | **3** receipt+Button lock                 | Was live defect        |
| Account/Safe/myorder  | **3** after A1′                   | n/a                 | n/a                                       | Was zero-coverage      |

## Score meaning

- **0** absent / false money
- **1** partial / toast-only
- **2** dialect present, gaps remain
- **3** gate-pass for this surface

## Next measurement

Re-score after #267 green CI + Orca pass with auth fixture (**never seed money as proof**).
