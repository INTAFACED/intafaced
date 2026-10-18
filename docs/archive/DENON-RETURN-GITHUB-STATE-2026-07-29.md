# Denon return — GitHub state (2026-07-29)

Nitro was AFK. Agents finished open Nitro work onto **main**. **Do not rebuild these.**

## On `main` this session (squash-merged, CI green)

| PR        | What                                                                     |
| --------- | ------------------------------------------------------------------------ |
| #99       | CI requires money-suite Postgres (no silent skip)                        |
| #89       | svc-pay `/trpc` mount proof + honest pay.gateway tracker                 |
| #98       | Stream A Phase 1 plan + terminal honesty bar                             |
| #91       | svc-ws public trade tape from `orderFilled`                              |
| #93       | svc-identity WebAuthn registration + assertion (§9)                      |
| #94       | svc-token live `stake` / `unstake` / epoch mint (+ keeps #97 governance) |
| #97       | token.governance (earlier)                                               |
| #96       | vendor residual wallet mass-credit + CORS                                |
| #87 / #90 | convert + protocol AMM                                                   |

**Main tip:** re-check with `git fetch && git log origin/main -1`.

## Stream split (still true)

- **Nitro Stream A** = app surface (`feat/app-*`, issue #83, `docs/NITRO-STREAM-A-CLAIM.md`)
- **Denon** = spine (`services/`, packages money paths, edge, compose, Java)

## Before you start a feature

```bash
gh pr list --state open
pnpm tracker ready   # after pull main
```

Open PRs + tracker `wip`/`done` on **main** are the claim board. Telegram is optional.

## Safe free work

Anything in `pnpm tracker ready` that is **not** listed above and has **no** open PR.

Money-enum / multi-asset / licence Priority-1 (chart path, MySQL connector) remain **your** product calls.
