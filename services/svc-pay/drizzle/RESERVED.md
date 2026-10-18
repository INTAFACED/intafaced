# svc-pay migration numbers

Parallel workstreams must not pick the same number. Take your range from the table, never from "next free".

| Range     | Owner                                                 | State                                           |
| --------- | ----------------------------------------------------- | ----------------------------------------------- |
| 0000-0037 | shipped on main                                       | applied; gaps at 0019, 0031 and 0034 already exist |
| 0038-0042 | branch `fix/svc-pay-onto-main` (unpushed)             | taken, do not use                               |
| 0043-0049 | unassigned                                            | free; ask W0 before using                       |
| 0050-0054 | W1 merchant control room                              | used                                            |
| 0055-0057 | W2 metrics read model                                 | reserved                                        |
| 0058-0059 | W5 halts and treasury exposure                        | used                                            |
| 0060-0061 | W6 conversion                                         | reserved                                        |
| 0062      | W9 screening                                          | used (screening cases)                          |
| 0063      | W10 B2B ramp (switched off)                           | left empty; shipped as 0078                     |
| 0064-0068 | W15 merchant operations APIs                          | used                                            |
| 0069-0070 | W16 venue, network and wallet-route registries        | reserved (0069 tables, 0070 audit events)       |
| 0071      | W4b merchant names                                    | used                                            |
| 0072      | unassigned                                            | free; ask W0 before using                       |
| 0073      | W2c-B team reads and settlement detail                | used                                            |
| 0074      | W2c limit-increase requests                           | used                                            |
| 0075-0076 | unassigned                                            | free; ask W0 before using                       |
| 0077      | W6 conversion quotes and order intents                | used                                            |
| 0078      | W10 B2B ramp (switched off)                           | used                                            |
| 0079      | W5 auto-trip window                                   | used                                            |
| 0080      | destination page key and statement scan lease         | used                                            |
| 0081      | subscription.create idempotency, one open subscription per mandate | used                               |
| 0082      | merchant portal business profile                      | used                                            |
| 0083      | dispute cases, rail deadlines, evidence bytes         | used                                            |
| 0084      | standalone merchant invoices                          | used                                            |
| 0085      | merchant portal activity, export kinds, webhook ops   | used                                            |
| 0086      | W6 prelive late-fill horizon, booking, hold timer     | used                                            |
| 0087      | payment link checkout re-read and create idempotency  | used                                            |
| 0088      | destination default, invoice lines, due date, email   | used                                            |
| 0089      | payout dispatched outcome before the rail call        | used                                            |
| 0090      | D-142 payout destination verified flag and pending change | used                                         |
| 0091      | FRAUDQUEUE fraud review cases                         | used                                            |
| 0092+     | unassigned                                            | free; ask W0 before using                       |

## Why gaps are safe

`scripts/migrate.ts` reads every `NNNN_*.sql` in the folder, sorts the names, and applies each one not yet recorded in `pay.__migrations` (keyed by file name, not by position). There is no journal and no "must be consecutive" check, and 0019, 0031 and 0034 are already missing on main. `tooling/ci/migration-check.mjs` only needs each up file to have a non-empty `.down.sql`. It ignores this file (it looks at `.sql` only).

## Rules

- Every migration ships with `NNNN_name.down.sql`.
- Use numbers inside your range in order. If you run out, ask W0; do not take a neighbour's number.
- A migration may only depend on lower-numbered ones that are on main, or on your own earlier numbers.
- Unused reserved numbers are simply left empty.
