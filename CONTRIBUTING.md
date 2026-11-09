# Working on INTAFACED

People and AI agents share one repo. This file is how that stays clean. The rules every agent follows are in [`AGENTS.md`](AGENTS.md). What is where is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 1 · How a change lands

The rules are in [`AGENTS.md`](AGENTS.md): read it first. In short: a short-lived branch in your own worktree, a pull request with its proof, the required checks green on its exact head, then a squash merge. No direct pushes to `main`: `.githooks/pre-push` blocks them and requires `format:check` (`pnpm install` turns the hook on); never use `--no-verify`. Never bypass a required check, and never weaken a gate to get green.

Branch names: `feat/<scope>-<what>`, `fix/<scope>-<what>`, `chore/<what>`, `docs/<what>`. PR titles: `<type>(<scope>): <what changed>`; a gate-file change needs a `ci:` or `gate:` title. Fill in the template. Don't turn on required approvals or code-owner reviews, and don't open PRs whose only job is status.

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

## 3 · Checks

CI job names, so you can find a failure fast:

| Check                                        | What it protects                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Doctrine gates`                             | the scans in `tooling/ci/gates.mjs`: brand, custody, secrets, migrations                                         |
| `Format`                                     | prettier                                                                                                         |
| `Typecheck & build`                          | the whole monorepo compiles                                                                                      |
| `Tests (changed)` / `Tests (1/8)` to `(8/8)` | the changed packages, their dependents and readers; a run-everything change runs the whole suite in eight shards |
| `CI merge seal`                              | one result for the checks the changed paths call for                                                             |
| `Definition of Done`                         | the per-service gate (`pnpm gate`)                                                                               |
| `Gitleaks` / `Dependency audit`              | secrets and known vulnerabilities                                                                                |

Which checks a change needs, and what to do with a red, is in AGENTS.md.

---

## 4 · Day one

```bash
gh repo clone Phantom-X-007/intafaced && cd intafaced
pnpm install
cp .env.example .env
pnpm platform:up        # or: pnpm infra:up for only the infrastructure
pnpm build && pnpm test
```

Then make your first change in a worktree (`pnpm wt feat/my-first-change`). Infrastructure ports (Postgres `5433`, Redis `6380`) are non-standard on purpose, so a native Postgres on `5432` does not collide.

---

## 5 · Commits

Conventional commits, because the scope prefix makes `git log` scannable:

```
feat(svc-ledger): hash-chain every transaction
fix(venue-adapter): exclude stale venues from routing
chore(ci): cache pnpm store between runs
docs(architecture): record the money flow
```

Commit messages inside a PR need not be perfect. The squash-merge title lands on `main`, so make that one good.

If `tooling/ci/value-gate.mjs` asks for a `Board-Delta:` or `Serial-Work:` trailer, its message says what to write. A bare trailer with no reason does not pass.
