# Claim agents.risk-compliance-refuse-empty

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**owner:** nitro-agent
**proof:** https://github.com/Phantom-X-007/intafaced/pull/1841
**tracker:** agents.risk-compliance (stays ready — slice, not mountain-done)
**branch:** feat/agents-risk-compliance-refuse-empty
**updated:** 2026-08-14
**Class:** N
**Board-Delta:** agents.risk-compliance refuse drafts when screening inputs empty.

Leverage: Phase A IN — existing `svc-agents` gateway/router + `packages/config` screening import. No sanctions content invented. No JURISDICTION_MATRIX `blocked:true` fill. No `identity.kyc-review` `reviewed_by` write.

One service: svc-agents.
