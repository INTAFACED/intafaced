# Claim agents.portfolio

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**owner:** denon-agent
**slice:** plan-only (no placeOrder)
**branch:** feat/agents-portfolio-plan
**proof:** https://github.com/Phantom-X-007/intafaced/pull/2224
**updated:** 2026-08-17

v2 Portfolio Agent plan slice: compare holdings vs owner-supplied targets.
Injected `PortfolioPort` (ops.portfolio view in-flight elsewhere). Unset port →
named dark refuse. Cross-plane legs refuse. Kill-switch default off. Every
attempt appends `agent_actions`-shaped audit. Class M the moment it places —
this PR does not place.
