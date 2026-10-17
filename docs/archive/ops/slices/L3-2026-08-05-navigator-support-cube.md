# L3 slice pack — navigator grounded + support assign + cube consumer

**Tip base:** re-derive `origin/main`  
**Does NOT invent L1/L2.**  
**Path-intersect:** avoid open partner file sets (`gh pr list` before edit).

---

## Slice A — agents.navigator Stage-2 grounded refuse

| Field       | Value                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| Outcome     | Navigator refuses plan/tool_select when trade data plane is dark instead of inventing quotes |
| Non-goals   | No shell UI; no money tools; no invent mid prices                                            |
| Done bar    | Pure `grounded.ts` + tests for plane dark/live; guardrail still Stage-1 allowlist            |
| Paths       | `services/svc-agents/src/navigator/**`                                                       |
| Class       | **N**                                                                                        |
| Depends     | L1 agents.navigator trk · Stage-1 #761                                                       |
| Board-Delta | navigator Stage-2 grounded refuse                                                            |

## Slice B — ops.support Stage-2+ assign from queue

| Field       | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Outcome     | Operator can pick next ticket from queue by score without money tools |
| Non-goals   | No ledger; no invent SLAs as currency                                 |
| Done bar    | `assignNext` pure function + tests on operator-queue                  |
| Paths       | `services/svc-support/src/**`                                         |
| Class       | **N**                                                                 |
| Depends     | Stage-2 queue #798                                                    |
| Board-Delta | support assign-next from queue                                        |

## Slice C — ops.analytics cube consumer purity

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Outcome     | Admin-facing consumer may only accept cube points that pass assertMetricPoint (no invent series) |
| Non-goals   | No BI product UI; no warehouse process                                                           |
| Done bar    | `consumeCubePoints` + tests refuse JS number money                                               |
| Paths       | `packages/contracts/src/ops-analytics*.ts`                                                       |
| Class       | **N**                                                                                            |
| Depends     | Slice B cube #795                                                                                |
| Board-Delta | analytics consumer purity                                                                        |
