# Claim bank.ramps-fiat-adapter-refuse

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** claimed
**owner:** denon-nitro-agent
**branch:** feat/bank-ramps-fiat-adapter-refuse
**tracker:** bank.ramps
**scope:** `services/svc-bank/src/ramps/**` plus router mount and error mapper for the new code
**done bar:** Public door refuses with a typed code when no pay adapter can settle fiat; no invented FX rates; no ledger recipes besides existing pay/bank ones; tests fail if a ramp looks live with empty rails.
**leverage:** Phase A IN — svc-pay RailAdapter plane (PayFiatRampPort names only, no svc-pay import) + ledger-client deposit/withdrawHold/withdrawSettle. Horizon bank.ramps = IN.
**do not touch:** Vue/shell; Shehzad chain; svc-pay (#1837); svc-academy (#1838); svc-notify (#1839); svc-p2p (#1840); svc-agents risk-compliance; wave-14 docs; Class X; tracker stays ready/done as on tip (no features.mjs mountain flip).
**updated:** 2026-08-14
