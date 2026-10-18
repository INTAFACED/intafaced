# 00-BASELINE — residual wave #229–#238

**Audit fire:** 2026-07-31T00:42Z  
**Method:** [`docs/WAVE-AUDIT.md`](../../WAVE-AUDIT.md) · **delta only** (not full archaeology)  
**Worktree:** `.worktrees/docs-wave-audit-229-238` · branch `docs/wave-audit-229-238`

## Tip freeze

| Field                        | Value                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------- |
| **Tip SHA (this audit)**     | `cd277dcc3fc2f71d3694b2eccc12b20d0fdb3f00`                                       |
| **Tip one-liner**            | `docs: residual ownership high water through #238 (#239)`                        |
| **Since (prior high water)** | `f42d41cc2f5440109bba5abe8e536c34bb6da179` · `#224` docs high water through #223 |
| **Commits in delta**         | 11 (`f42d41c..cd277dc`)                                                          |
| **Post-product CI tip**      | `46d688e` (#238 Activity) — Actions **SUCCESS** run on main                      |
| **Tip after docs #239**      | `cd277dc` — docs-only; no product delta vs #238                                  |

## Open PRs at audit time (pre-merge, babysit only)

| PR       | Title                                                                    | Class         | CI (audit time)                  | Nitro merge?                                            |
| -------- | ------------------------------------------------------------------------ | ------------- | -------------------------------- | ------------------------------------------------------- |
| **#226** | feat(pay): live EVM crypto rail for crypto-native                        | **M** money   | green (Doctrine/Tests/Build/DoD) | **NO** — Denon money self-audit then author/Denon merge |
| **#227** | feat(ws): private positions stream completes ws.gateway                  | **P** spine   | green                            | Prefer Denon; babysit only                              |
| **#228** | feat: AMM compile unblock + terminal charts/equity + owner ops checklist | **P+N** mixed | green                            | Prefer Denon merge / split; no Nitro auto-merge         |

## Prior partial

- [`docs/audit/2026-07-31-overnight-ab/WAVE-AUDIT-PARTIAL.md`](../2026-07-31-overnight-ab/WAVE-AUDIT-PARTIAL.md) — fire start at `f42d41c`; cascade residual noted closed by #229
- Prior overnight wave: [`docs/audit/2026-07-30-overnight-wave/WAVE-AUDIT-RESULT.md`](../2026-07-30-overnight-wave/WAVE-AUDIT-RESULT.md)

## Honesty anchors (carry forward)

1. **#226 still open Class M** — residual not closed by this wave.
2. **Dual-book ADR** — still human / owner decision; UI banners do not close policy.
3. **Secrets** — still owner ops (rotation, heapdump, wallet keystore) — not agent-done.
4. **Not go-live.** Audit exit ≠ product complete ≠ money e2e.
