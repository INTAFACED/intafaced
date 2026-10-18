# Claim — academy.certs unpriced cert publishes nothing

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Lane id:** `academy.certs-unpriced-refuse`  
**Owner session:** Denon · Grok  
**Tracker:** `academy.certs` (stays `ready` — mountain not done until multi-svc cert→perk product law)  
**Branch:** `feat/academy-certs-unpriced-refuse`  
**status:** claimed  
**Class:** N (honesty refuse; no ledger; no invent perk magnitudes)

## Goal

Unpriced certs publish nothing. `grantCert` → XP → real identity perks, or refuse invent perk money. svc-identity remains SoT; no academy-local perk book.

## Done-bar

- Tests fail if an unpriced cert still looks like a granted perk/money
- No invented perk magnitudes
- No Vue
- Tracker stays `ready`

## Scope

- `services/svc-academy/src/certs/**` (perk-plane + xp-publish honesty)
- Surgical `router.ts` perk outcome reason + mount test

## Do not touch

- Vue / nitro-frontend-all
- Shehzad chain
- Dual-edit #1841 svc-agents, #1848 svc-pay, #1849/#1850 ws/notify, svc-trade MM
- `features.mjs` (tracker stays ready)
- ambassadors (prefer certs/perk-plane)

## Leverage

Phase A IN — existing `certPerkPlane` / `grantCert`. Horizon `academy.certs` = IN.
