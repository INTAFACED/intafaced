# 04-ADVERSARIAL — maker-checker (mega-r2)

## Prior #176 critics (inherited; not re-opened without regression)

| Finding        | Critic        | Verdict                               |
| -------------- | ------------- | ------------------------------------- |
| M1             | fresh-context | ACCEPT                                |
| R5             | fresh-context | ACCEPT                                |
| R6             | fresh-context | ACCEPT-WITH-NITS (sell cost residual) |
| BRAND / WS-JWT | fresh-context | ACCEPT                                |

## This run

### L7-EQUITY-STALE

| Field                | Value                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Finding              | Terminal claimed no balance surface; REST exists                                          |
| Fix                  | Honest copy: API exists; panel not wired; no invented numbers                             |
| Critic               | fresh-context explore agent (session model), read-only                                    |
| Critic verdict       | _(filled after critic returns — default ACCEPT if copy matches evidence)_                 |
| False-done check     | No tests weakened; no invented balances; no `as any`; no catch-swallow; no scoreboard lie |
| Refutation recorded? | n/a unless REJECT                                                                         |

### False-done check (fix diff)

- [x] No test `.skip` / assertion delete
- [x] No empty catch / `?? 0` on money
- [x] No type suppression on money/principal
- [x] No invented candles/balances/positions
- [x] No tracker `done` flip without mount
- [x] No "CI green" claim
