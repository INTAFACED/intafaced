# Instructions for AI agents

INTAFACED monorepo. Build the product and ship it.

Doctrine: [`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md). Protocol: [`tooling/agent-protocol/AGENT_PROTOCOL.md`](tooling/agent-protocol/AGENT_PROTOCOL.md).

Locate code with `rg`, `rg --files`, and focused Git history. Graphify is retired; historical instructions to install, query, or update it are obsolete.

## Ship (full access)

1. Review, audit, and debug the change. **Merge when done.** Any agent may merge their own pull request.
2. **Merge only after the merge gate passes.** Run `node tooling/scripts/merge-gate.mjs <pr> --head <sha>` from a clean, up-to-date `origin/main` checkout, not from the PR's branch. It waits for finished checks, requires passing Gitleaks and Dependency audit, and verifies changed-path CI coverage. Failures are introduced, inherited, environmental or unknown; an inherited exception needs exact head/base checkout evidence, matching failure signatures, and an owner/evidence declaration. Money/security failures are never excused. Money/security changes require an independent Claude Opus transcript review naming the exact head and reviewer session, distinct from the declared author session. That review counts only when its report quotes the canonical patch hash and file list the gate computed; a transcript `git diff` is not proof, and review independence is an accident guard. The tested main parent must be the live `origin/main` ref. Docs-only PRs get an explicit report; agent-rule files are never docs-only. Gate-file changes need a `ci:` or `gate:` title and must pass main's copy of the gate. PASS writes an exact-head receipt; the gate never merges. Follow [the evidence and review format](docs/tooling/evidence-merge-check.md). A 403 or 429 from `gh` means stop: no retries, account switching or new tokens.
3. Start without waiting for a person, an audit seal, FREEZE, a tracker claim, LIVE-LANES, or `pnpm ledger`. A blocked money path refuses closed, with an honest empty state. Leave the audit flag alone.
4. Any product path is fair game once its dependencies are met, including money. A blank price, limit, or sanctions list stays blank: refuse that action with a typed error. Do not invent live §8 magnitudes or sanctions list content.

## Money

1. Move value only through `packages/ledger-client`. No module holds its own balance.
2. Never store money in a `number`. Decimal strings on the wire, scaled bigint in memory.
3. A **second money book** is out. This redesign may replace the product UI and the unsettled color lock: [`docs/adr/2026-10-02-redesign-may-replace-product-ui.md`](docs/adr/2026-10-02-redesign-may-replace-product-ui.md). **Internet leverage law:** [`docs/INTERNET-LEVERAGE-LAW.md`](docs/INTERNET-LEVERAGE-LAW.md). Exchange take/keep/never: [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md) **§0.3**. Leave FIX, SBE, and Greeks as adapters. Leave npm `ccxt` and a second CLOB uninstalled. INTACHAIN stays parked until Nitro writes GO.

## One chain of work

1. Work in a worktree (`pnpm wt <branch>`), never the main checkout. Bare `git worktree add` is the wrong start. Orca `worktree create` is the same thing with a sidebar card.
2. One service per pull request. Never push `main`.
3. If an open pull request already touches that service, or the same files, leave it and take a different part. Several agents may work at once on different parts.
4. When you stop and this folder is not home, remove the worktree from the home checkout with `git worktree remove --force`. `orca worktree rm` deletes the branch. `git branch -D` deletes the branch. Leave home, OS, and PSP in place. `pnpm wt <branch>` restores a folder.

## INTACHAIN

Trading stays on the house book. Base work that already exists continues. INTACHAIN stays parked until Nitro writes GO. Leave `svc-chain` and P1 unstarted. [`docs/adr/2026-09-03-protocol-rails-until-intachain.md`](docs/adr/2026-09-03-protocol-rails-until-intachain.md).

## What you write

Spend the session on the product. `/grill-with-docs` may add one `GLOSSARY.md` entry, or one ADR in the existing dated `docs/adr/` shape, when a word or a hard-to-reverse decision has just settled. Do not start a `0001-` series. Status boards, LIVE-LANES, and tracker recooks stay unwritten.

Coordination map, not a permission system: [`docs/COORDINATION-TRUTH-LAYERS.md`](docs/COORDINATION-TRUTH-LAYERS.md).

## Skills

Use the installed skills. This file wins where a skill says to wait for a person, wait for CI beyond the merge gate, or use `git worktree add`.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on Phantom-X-007/intafaced. Use the `gh` CLI only when an active account is logged in. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles, each label equal to its name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` and dated ADRs in `docs/adr/`. See `docs/agents/domain.md`.
