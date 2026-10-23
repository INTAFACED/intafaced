# Claim trade.algo (create refuse copy covers VWAP/POV)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.algo` (stays **ready**)
**branch:** `feat/algo-create-refuse-kind-honest`
**class:** N

File-disjoint from `#1821` (place-grant). Shared `createTwap` door must not say “TWAP” when mark is missing or duration/slice bounds fail — those checks run before kind.

## Non-goals

- Icebergs
- Dual-edit `#1819` / `#1820` / `#1821` grant files
