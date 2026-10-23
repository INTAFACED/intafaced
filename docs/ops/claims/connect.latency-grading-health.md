# Claim connect.latency-grading (health consumer)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `connect.latency-grading` (stays **ready** — SOR still the ranking consumer; thresholds unruled)
**branch:** `feat/connect-latency-health-surface`
**class:** N

svc-trade `GET /health` reads `latencyGrade()` on the configured public venue adapter. Ungraded stays `null`. Does not 503. No letter→bps invent.

## Leverage

Existing `MarketDataAdapter.latencyGrade` + `isGraded`. No second grader.

## Non-goals

- Dual-edit #1827 public-rest / exchange-contract
- `services/svc-execution` scaffold
- Retuning DEFAULT_THRESHOLDS
