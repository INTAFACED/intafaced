# Claim PKT-C7 (dark-feed adjudication)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** wip  
**owner:** denon-agent (Phantom-X-007)  
**branch:** feat/pkt-c7-dark-feed-adjudication  
**lane:** denon-pkt-c7-dark-feed  
**updated:** 2026-08-17

Docs-only seal: jobs must not settle frozen/`closing` positions; an operator may settle only
with an adjudicated price and author recorded on the row. Horizon hours stay unset — unset
means no auto-alert timing invent (including not reusing `liquidationMaxAgeSeconds`).

**Scope:** ADR addendum on `docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md` +
packet index PKT-C7 + this claim.  
**Do not touch:** `svc-trade` · invent N-hour horizon · Vue · Shehzad · dual-edit
`docs/LIVE-LANES.md` (tip file fails Prettier; claim lives here instead).
