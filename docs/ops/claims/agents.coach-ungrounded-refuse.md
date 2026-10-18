# Claim agents.coach-ungrounded-refuse

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** claimed
**owner:** cursor-denon
**slice:** ungrounded coach is refuse, not a chatbot; no position advice
**tracker:** agents.coach
**branch:** feat/agents-coach-ungrounded-refuse
**updated:** 2026-08-14
**Class:** N
**Board-Delta:** agents.coach refuses ungrounded / position / invented-library sessions.

## Goal

Empty / unwired curriculum must not look like a live coach. Licensed library titles are not invented. Position-grounded coaching stays refused until an owner ruling.

## Done-bar

Tests fail if an empty catalog returns a coaching session; unknown slugs are `invented_library` refuse; `includePositions` / position asks refuse; `asAdvice` refuse; tracker stays ready (academy.curriculum library import residual).

## Leverage

Phase A IN: existing `services/svc-agents` tRPC router (same door shape as `agents.risk-compliance` #1841). No second fleet factory. No Vue. No invented lesson bodies.

## Do not touch

- #1848/#1851/#1853 svc-pay · #1855 svc-ws · #1856 svc-edge · #1857 svc-trade
- Shehzad chain · invent licensed library titles · reference live positions as advice
- tracker stays `ready` (mountain event not this slice)
