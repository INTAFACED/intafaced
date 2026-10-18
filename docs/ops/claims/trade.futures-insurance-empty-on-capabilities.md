# Claim trade.futures (empty insurance pot blocks live list — advertised)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.futures` (stays **wip** — no invent target size)
**owner session:** Denon agent
**class:** N
**branch:** `feat/futures-insurance-empty-on-capabilities`
**scope:** capabilities `notes.futures.insurance*` + `/health` `insuranceListing`

DIRECTION:33 empty pot → no live list. Target size stays `owner_unset`. Does not read the pot on `/health` (would invent "funded" if ledger is down).

## Leverage

Phase A IN: existing `checkInsuranceFundedForListing` + capabilities note.

## Non-goals

- Invent fund $ / schedule
- Dual-edit #1869 listOpen
