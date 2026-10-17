# L3 free-TRK wave16 — Stage-1 pure helpers

**Tip base:** wave15 (#846)  
**Class:** N  
**Board-Delta:** free implementable TRK Stage-1 deepen (local historical pack; thrift deleted 2026-08-07)

## Helpers

| TRK / module        | Additions                                                        |
| ------------------- | ---------------------------------------------------------------- |
| ops.analytics       | `hasMoneyMetrics`, `metricCountBySource`                         |
| academy.ambassadors | `listAllUserIds`, `totalCount`                                   |
| academy.tournaments | `scoreSpread`, `hasStanding`, `listEndedSeasonIds`               |
| academy.curriculum  | `curriculumSpineSize`, `listCurriculumTitlesByPath`              |
| ops.affiliates      | `isRoot`, `depthOf`                                              |
| ops.notifications   | `acceptedChannels`, `failedChannels`, mute `isMuted`/`muteCount` |

Honesty: no money moves · empty never invents · historical note — thrift deleted 2026-08-07; open PR when unit is done.
