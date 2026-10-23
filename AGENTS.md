# Instructions for AI agents

INTAFACED monorepo. Doctrine: [`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md). Protocol: [`tooling/agent-protocol/AGENT_PROTOCOL.md`](tooling/agent-protocol/AGENT_PROTOCOL.md).

Build the product. Do not spend the session writing `docs/**` boards, ADRs, LIVE-LANES, or TRACKER recooks.

## Hard stops (money + integrity only)

1. Never move value outside `packages/ledger-client`. No module holds its own balance.
2. Never store money in a `number`. Decimal strings on the wire, scaled bigint in memory.
3. Work in a worktree (`pnpm wt <branch>`), never the main checkout. Do not use bare `git worktree add`. Orca `worktree create` is the same thing with a sidebar card.
4. One service per PR. Never push `main`.
5. Do not rebuild the product SPA or a **second money book**. Prefer existing shell + ledger + `svc-*`. **Internet leverage law:** [`docs/INTERNET-LEVERAGE-LAW.md`](docs/INTERNET-LEVERAGE-LAW.md). Exchange OSS take/keep/never: [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md) **§0.3**. Mega backend (non-frontend) **v1.25:** [`docs/SPEC-BACKEND-MEGA-PLAN-2026-09-03.md`](docs/SPEC-BACKEND-MEGA-PLAN-2026-09-03.md). Live-wire: [`docs/SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md`](docs/SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md). Do not hand-roll FIX/SBE/Greeks. Do not install npm `ccxt` or a second CLOB. **Protocol rails until INTACHAIN:** house book + Base P0; **do not start `svc-chain` / P1** until Nitro GO — [`docs/adr/2026-09-03-protocol-rails-until-intachain.md`](docs/adr/2026-09-03-protocol-rails-until-intachain.md).
6. **Desk close-out.** When you stop (PR merged/closed, or work is on the branch and you are done): if this folder is not home, `git -C /Users/Nitro/projects/Sovereign worktree remove --force "$(pwd)"`. Never `orca worktree rm` (it tries to delete the branch). Never `git branch -D`. Never remove home, OS, or PSP. `pnpm wt <branch>` restores the folder. Do not leave Orca sidebar cards standing.

## Autonomy (full access)

- **No human gate before start.** Do not wait for Nitro, Denon, audit seal, FREEZE, tracker claim, LIVE-LANES, or `pnpm ledger`.
- **No ping to unblock.** If blocked, use refuse-closed code + honest empty states — never ask a human to flip an audit flag.
- **Merge when done.** Any agent may merge their own PR. **Do not wait for CI green** — GitHub Actions is informational, not a ship gate. Same for `pnpm verify`: optional local check, never a blocker.
- **All tracker rows are fair game** when deps are met — including money and protocol paths. Path-intersect open PRs before edit is optional courtesy, not permission.
- **Unset owner numbers:** refuse-closed in code (blank env → typed error). Do not invent live §8 magnitudes or sanctions list content.

## Coordination (optional)

[`docs/COORDINATION-TRUTH-LAYERS.md`](docs/COORDINATION-TRUTH-LAYERS.md) — tracker is a map, not a permission system.

## Skills

Repo law beats installed skills. Skills that say `git worktree add` or block ship on CI/verify are wrong here.

## Code navigation

Locate code with `rg`, `rg --files`, and focused Git history. Graphify is retired; historical instructions to install, query, or update it are obsolete.
