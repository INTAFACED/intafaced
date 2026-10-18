# Claim — support comment draft wire

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Owner session:** grok agents-support-draft  
**Paths:** `services/svc-agents/src/router.ts`, `services/svc-agents/src/support-agent/**`, `services/svc-agents/src/copy.ts`, `tooling/ci/reachability-scan.mjs`  
**status:** merged
**proof:** #973 merged 2026-08-07 — support comment draft is reachable on tRPC
**updated:** 2026-08-07 (claim closed against merged main)
**Class:** N  
**Board-Delta:** Wire draftTicketComment to tRPC; unpark comment-draft.ts. No ledger, no ticket post.

> Closed by the claim-board honesty pass. The code merged; the claim was never closed, so
> `swarm:freeze` kept reporting this mountain as owned by a session that no longer exists.
> Residual noted above (if any) is unchanged and still real — closing the claim closes the
> SLICE, not the mountain. Mountain state lives in `tooling/tracker/features.mjs`.
