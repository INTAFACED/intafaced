# L3 free-TRK wave21 — Stage-1 pure helpers

**Tip base:** wave20 (#851)  
**Class:** N  
**Board-Delta:** free implementable TRK Stage-1 (local historical pack; thrift deleted 2026-08-07)

## Helpers

| Area                | Additions                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| ops.analytics       | `countMoneyMetrics`, `hasNonMoneyMetrics`                                  |
| academy.ambassadors | `hasAnyProgrammeRow`, `frozenRatio`                                        |
| academy.tournaments | `thirdPlaceUser`, `lastPlaceUser`, `endedSeasonCount`, `hasLiveSeason`     |
| academy.curriculum  | `listLessonSlugs`, `playbookCount`                                         |
| ops.affiliates      | `maxChainDepth`, `referrerCount`                                           |
| ops.notifications   | `refusedChannels`, `fanoutAcceptanceRatio`, `planHasSkips`, `countSendNow` |
