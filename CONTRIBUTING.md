# Working on INTAFACED

People and AI agents share one repo. This file is how that stays clean. The rules every agent follows are in [`AGENTS.md`](AGENTS.md). What is where is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 1 · The model: GitHub Flow

- `main` is always deployable. Every change is a short-lived branch, then a pull request, then a squash merge.
- No direct pushes to `main`. `.githooks/pre-push` blocks `git push` to `main` and requires `format:check`; `pnpm install` turns the hook on (`package.json` `prepare`). `--no-verify` skips the hook, so do not use it.
- No long-lived branches. A branch older than about two days is a merge conflict waiting to happen. Split the work instead.
- If `main` is red, diagnose the failure and coordinate a focused fix without competing edits. Never weaken a gate to get a green result.
- Do not turn on required approvals or code-owner reviews. Review is asked for, not waited on (see section 3).

Branch names: `feat/<scope>-<what>`, `fix/<scope>-<what>`, `chore/<what>`, `docs/<what>`. The scope is a service or package, for example `feat/svc-identity-rank-events`.

---

## 2 · Worktrees are mandatory

Nobody works in the main checkout. Each branch gets its own directory, its own `node_modules` and its own dev server, so two agents can never edit the same files by accident.

```bash
pnpm wt feat/svc-identity-rank-events   # create a worktree and install dependencies
pnpm wt:list                            # what exists
git worktree remove <worktree-path>     # when your task is merged or handed off
```

`pnpm wt` creates the worktree in a `<checkout-folder>-worktrees` folder beside the main checkout (`tooling/scripts/worktree.mjs`); for the Sovereign checkout that is `sovereign-worktrees`. Open your editor or agent in the worktree, not in the main checkout.

Remove only your own worktree, never with `--force`. Never delete a branch. Never run `pnpm wt:rm`, `pnpm wt:gc:apply` or `orca worktree rm`; they delete branches or force-remove.

---

## 3 · Pull requests

One service per PR. If describing it needs the word "and", it is two PRs. A cross-service change is two PRs in order: the `packages/contracts` or `packages/events` PR first.

Title: `<type>(<scope>): <what changed>`, for example `feat(svc-identity): rank recalculation on XP events`. A PR that changes a gate file (for example `tooling/ci`, `.github/workflows`, `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `tooling/agent-protocol`; full list: `GATE_PATHS` in `tooling/scripts/gate-file-guard.mjs`) needs a `ci:` or `gate:` title. Fill in the template: what changed, why, how you know it works.

Review: the author checks their own change, and an independent reviewer checks the exact head. Every PR gets an independent review of the exact head commit. When you review, look in this order:

1. Does it touch money? Read every line, and check the tests cover the failure branches.
2. Does it cross a service boundary without `packages/contracts` or `packages/events`? Reject.
3. Does it hold a balance outside the ledger? Reject.
4. Is anything "temporary" or faked to look live? Reject.
5. Everything else.

Do not open PRs whose only job is status or a board update.

Merge: squash, one commit per PR. Merge only when the required checks (`CI merge seal`, Gitleaks and Dependency audit) are green on the exact head and, for a money, security or gate-file change, the independent review passed that same head (AGENTS.md, "Check, then merge"). A red is confirmed by one re-run, never by a skip; a test that fails and then passes is flaky and gets an owner. There is no bypass.

---

## 4 · Checks

Run these on your machine before you push: affected tests, typecheck, and `pnpm exec prettier --check` on the files you changed. `pnpm verify` is a broad local check (gates, format, build, typecheck, test).

CI job names, so you can find a failure fast:

| Check                                        | What it protects                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Doctrine gates`                             | the scans in `tooling/ci/gates.mjs`: brand, custody, secrets, migrations                                        |
| `Format`                                     | prettier                                                                                                        |
| `Typecheck & build`                          | the whole monorepo compiles                                                                                     |
| `Tests (changed)` / `Tests (1/4)` to `(4/4)` | the changed packages, their dependents and readers; a run-everything change runs the whole suite in four shards |
| `CI merge seal`                              | one result for the checks the changed paths call for                                                            |
| `Definition of Done`                         | the per-service gate (`pnpm gate`)                                                                              |
| `Gitleaks` / `Dependency audit`              | secrets and known vulnerabilities                                                                               |

The merge gate blocks on failures your PR introduces; the rules are in AGENTS.md ("Check, then merge"). GitHub itself requires Gitleaks, Dependency audit and Doctrine gates to pass; a gate PASS does not override them, and you never bypass them.

A 403 or 429 from GitHub means stop: report the response, keep working locally, and follow `tooling/agent-protocol/AGENT_PROTOCOL.md` section 3 before you resume. A merge is not a launch: deploys, live credentials, purchases and real funds need the owner.

---

## 5 · Day one

```bash
gh repo clone Phantom-X-007/intafaced && cd intafaced
pnpm install
cp .env.example .env
pnpm platform:up        # or: pnpm infra:up for only the infrastructure
pnpm build && pnpm test
```

Then make your first change in a worktree (`pnpm wt feat/my-first-change`). Infrastructure ports (Postgres `5433`, Redis `6380`) are non-standard on purpose, so a native Postgres on `5432` does not collide.

---

## 6 · Commits

Conventional commits, because the scope prefix makes `git log` scannable:

```
feat(svc-ledger): hash-chain every transaction
fix(venue-adapter): exclude stale venues from routing
chore(ci): cache pnpm store between runs
docs(architecture): record the money flow
```

Commit messages inside a PR need not be perfect. The squash-merge title lands on `main`, so make that one good.

If `tooling/ci/value-gate.mjs` asks for a `Board-Delta:` or `Serial-Work:` trailer, its message says what to write. A bare trailer with no reason does not pass.
