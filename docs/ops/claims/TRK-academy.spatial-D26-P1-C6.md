# Claim — academy.spatial backend scene integrity (D26-P1-C6)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Lane id:** `denon-d26-p1-c6-spatial-fp`  
**Owner session:** Denon · Grok  
**Tracker:** `academy.spatial` (backend integrity slice only — not FE canvas title)  
**Branch:** `feat/academy-spatial-c6`  
**Status:** LIVE

## Scope

- `services/svc-academy/src/spatial/edit-policy.ts` (+ spatial unit tests)
- Require `expectedFingerprint` after non-empty server scene (host-edit honesty)
- No FE / i18n / shell canvas polish

## Do not touch (open academy PR path sets)

- `#1725` ambassadors · `#1723` certs · `#1712` paper · `#1711` tournaments  
  (avoid shared `router.ts` / `academy-service.ts` / `features.mjs` / `LIVE-LANES.md`)
- `nitro-frontend-all` paths
- Shehzad chain

## Proof

Host write omit-fp on non-empty → `conflict` via `decideHostSceneWrite` (wired through existing `updateScene`).
