# L3 free-TRK wave10 — Stage-1 pure helpers

**Tip base:** `origin/main` @ wave9 (#840)  
**Class:** N (non-money Stage-1 deepen)  
**Board-Delta:** free implementable TRK residual-own Stage-1 helpers

## What

| TRK                 | Helper                                               |
| ------------------- | ---------------------------------------------------- |
| ops.analytics       | `hasAnalyticsMetric`, `countMetricsByKind`           |
| academy.ambassadors | `isActiveAmbassador`, `appointingOperators`          |
| academy.tournaments | `scoreOfUser`, `countStandingsAboveScore`            |
| academy.curriculum  | `countCurriculumByKind`, `listCurriculumSlugsByKind` |
| ops.affiliates      | `edgeCount`, `hasReferrer`                           |
| ops.notifications   | `countFanoutFailures`, `allChannelsRefused`          |

## Honesty

No money moves · empty never invents rows · missing user → null/false · partner paths untouched.

## Proof

Focused vitest on touched modules; `pnpm gates` before open when the unit is done.
