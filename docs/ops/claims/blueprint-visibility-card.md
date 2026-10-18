# Claim — blueprint visibility-gated card

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Lane:** `nitro-blueprint-visibility-card`  
**Branch:** `feat/blueprint-visibility-card`  
**Owner session:** Nitro agent (svc-blueprint residual)  
**Status:** claimed 2026-08-15

## What

Implement the visibility check `packages/auth` already names: reading someone
else's Blueprint is governed by `blueprints.visibility` on top of
`blueprint:read`. Authenticated `cardOf` + `setVisibility`. No public unfurl
URL. No rasterizer. No second card renderer.

## Do not touch

pay · identity · academy · support · notify · p2p · bank · market · indexer ·
frontend · Shehzad chain · object-storage / Class X PNG rail
