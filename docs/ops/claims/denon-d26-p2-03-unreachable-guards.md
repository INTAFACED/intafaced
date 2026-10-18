# Claim denon-d26-p2-03-unreachable-guards

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** wip
**owner:** denon-agent (Phantom-X-007)
**tracker:** D26-P2-03
**branch:** feat/d26-p2-03-unreachable-guard-inventory
**tip:** origin/main @ 1723273b
**updated:** 2026-08-15

Tip inventory of unreachable money guards (trade/matching). Docs only. Map existing promise-falsify public-door suites + matching `#1730` doors vs unit-only tests / uncalled helpers. No silent “fixed” without a door test.

**Scope:** this claim + `docs/LIVE-LANES.md` (this row only) + `docs/D26-P2-03-UNREACHABLE-MONEY-GUARD-INVENTORY-2026-08-15.md`.
**Do not touch:** `services/svc-trade` (#1946), `services/svc-matching` (P2-01d sibling), svc-edge, Vue.
