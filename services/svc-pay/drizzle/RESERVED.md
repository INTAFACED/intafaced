# svc-pay migration numbers

Parallel workstreams must not pick the same number. Take your range from the table, never from "next free".

| Range     | Owner                                                 | State                                           |
| --------- | ----------------------------------------------------- | ----------------------------------------------- |
| 0000-0037 | shipped on main                                       | applied; gaps at 0019, 0031 and 0034 already exist |
| 0038-0042 | branch `fix/svc-pay-onto-main` (unpushed)             | taken, do not use                               |
| 0043-0049 | unassigned                                            | free; ask W0 before using                       |
| 0050-0054 | W1 merchant control room                              | reserved                                        |
| 0055-0057 | W2 metrics read model                                 | reserved                                        |
| 0058-0059 | W5 halts and treasury exposure                        | reserved                                        |
| 0060-0061 | W6 conversion                                         | reserved                                        |
| 0062      | W9 screening                                          | reserved                                        |
| 0063      | W10 B2B ramp (switched off)                           | reserved                                        |
| 0064-0068 | W15 merchant operations APIs                          | used                                            |
| 0069-0070 | W16 venue, network and wallet-route registries        | reserved (0069 tables, 0070 audit events)       |
| 0071+     | unassigned                                            | free; ask W0 before using                       |

## Why gaps are safe

`scripts/migrate.ts` reads every `NNNN_*.sql` in the folder, sorts the names, and applies each one not yet recorded in `pay.__migrations` (keyed by file name, not by position). There is no journal and no "must be consecutive" check, and 0019, 0031 and 0034 are already missing on main. `tooling/ci/migration-check.mjs` only needs each up file to have a non-empty `.down.sql`. It ignores this file (it looks at `.sql` only).

## Rules

- Every migration ships with `NNNN_name.down.sql`.
- Use numbers inside your range in order. If you run out, ask W0; do not take a neighbour's number.
- A migration may only depend on lower-numbered ones that are on main, or on your own earlier numbers.
- Unused reserved numbers are simply left empty.
