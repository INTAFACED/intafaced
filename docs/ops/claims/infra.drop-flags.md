# Claim infra.drop-flags

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**proof:** https://github.com/Phantom-X-007/intafaced/pull/2211
**owner:** Phantom-X-007
**branch:** feat/infra-drop-flags-waitlist-capture
**updated:** 2026-08-17

Honesty close: waitlist capture already lives on svc-identity (`waitlist.enroll` + SQL + `assertEnabled`). This slice flips FLAG_REGISTRY `waitlist.enabled` / `referral.queue` to `request-path` so OFF is a named refuse, not a silent open. No LIVE-LANES. Tracker not stamped done (founding badges / season residual).
