# Claim D26-P3-06 (auth / session security review)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** wip  
**owner:** denon-agent (Phantom-X-007)  
**branch:** feat/auth-session-security-review  
**lane:** denon-d26-p3-06-auth-review  
**tip:** origin/main @ fb819742  
**updated:** 2026-08-15

Written fiat-plane auth/session review. Residuals named in `docs/audits/AUTH-SESSION-SECURITY-REVIEW-2026-08-15.md` (R-AUTH-01…03).

**Scope:** that audit + this claim + LIVE-LANES row.  
**Do not touch:** identity tracker done-flips; `#2032` identity money doors; `svc-trade` / `svc-edge` / `svc-agents` / `svc-p2p` / `svc-support`; Vue; Shehzad; Class X secrets; invent prod WebAuthn origins.
