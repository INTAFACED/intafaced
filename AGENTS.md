# Rules for agents

INTAFACED is an exchange, a bank and a payments platform. You own an outcome: build it, prove it in the running app, and merge it. Where another file disagrees with this page, this page wins. Agreed acceptance criteria win; report conflicts.

## The floor

1. **Money moves only through `packages/ledger-client` recipes.** Never assemble entries inline. There is one ledger (`svc-ledger`): no module holds its own balance, and there is no second money book (no outside system as source of truth for what the ledger records, no second order book of our own, no npm `ccxt`; outside markets, users' own wallets, FIX, SBE and Greeks are reached through adapters). The ledger is authoritative for its own recorded obligations, never over a wallet's or an outside market's own state. At launch the ledger records only INTAFACED's own money; a recipe that touches a customer account is the custodial layer, kept and switched off (`LEDGER_CUSTODY_LAYER`). Read `docs/adr/2026-11-10-launch-money-model.md` before any money change.
2. **Never store money in a `number`.** Decimal strings on the wire, scaled bigint in memory.
3. **Idempotency keys are business keys** (`deposit:crypto-native:0xabc`), never `randomUUID()`. Every money path tests its failure branches and has an invariant test. Ask: if this crashes exactly here, whose funds are stranded?
4. **Protocol Plane services never import ledger write recipes** (`pnpm scan:custody`). Freezing one account belongs to `svc-identity`; the platform-wide posting freeze belongs to `svc-ledger`.
5. **`main` stays protected and green.** Never push `main`. Never bypass a required check or change the `main` ruleset (`CI merge seal`, Gitleaks, Dependency audit; no force-push, no delete); its bypass list stays empty. A breaking commit is fixed or reverted before anything else merges into the packages it touches.
6. **Never skip, disable, quarantine or weaken a test or safeguard** to get green. A test that is wrong is fixed, with the evidence in the PR body. The one exception is the machine's: CI sets aside a journey step that fails and then passes on the same commit on main, for a limited time with an owner, and never a money step (`tooling/ci/journey-verdict.mjs`). No agent sets anything aside. A set-aside step never counts as proven.
7. **The owner alone:** deploys, real funds, live credentials, secrets and keys, purchases, and contact with anyone outside. This repo is public: no business details or text from the owner's private repos in its files, PRs, issues or comments. A merge is not a launch.
8. **Honest product and honest claims.** No fake balances, books, prices, limits or metrics; an illustrative figure says TEST. A blank owner value (a price, limit, fee, sanctions list or provider setting) stays blank and refuses with a typed error; a labelled TEST value may stand in on test stacks only. A claim in a PR body comes with its output.

## The owner's decisions

Within the floor, these win over any agent's or reviewer's preference.

- **Standing green light:** push branches, open PRs, delete files through a PR, and merge once the checks allow it. Nothing waits for a person.
- **One PR may carry one whole journey across services.** Keep a journey together when it can be reviewed and reverted safely, money and security code included.
- **Money, security and supply-chain code are reviewed like every other PR** (supply chain: `.github/`, the lockfile, `.npmrc`, `pnpm-workspace.yaml`, Dockerfiles, `.dockerignore`, compose files, `tsconfig.base.json`, `tooling/infra/`) until Launch hardening, the phase that must pass before any real money moves. Gate files and look baselines keep their extra review.
- **One automatic review per PR, the CI review, and proof in CI:** no `/code-review` of the author's own, no council, no review round before opening; journeys prove in CI on the PR's head. The CI review's own rules change through a normal PR. The Codex bot's comment is advice (owner, 22 Nov): fix a real P0 or P1 it finds, never wait for it.
- **The front end is React** (`apps/customer` with Vite, `apps/admin` with Next.js).
- **Nothing is hidden.** Parked means visible with its real blocker named. No "coming soon": every room gets its full layout and every control, with an honest empty or refusal state. `/chain`, `/dex` and `/protocol` stay visible with honest labels. Never call Base INTACHAIN mainnet, and never set `audited: true` (the audit is external).
- **The owner sets the look's direction** (project-state `design/new-look/README.md`; the beta is dark only) **and walks the beta once, on a live link.** Between those the kit and its checks decide, and nothing asks the owner. Customer rooms take their look only from `packages/ui` role tokens (`.claude/rules/design.md`; `tooling/ci/look-drift.mjs`).

## Code Review Rules

For the Codex review bot: flag only P0 and P1, a bug that breaks a journey step's words, a money, custody, permission or count invariant, or security; quote the line and the intent it breaks. No style, naming, comments, refactors or new checks.

## How work flows

1. **Own one outcome,** usually one whole journey in `docs/roadmap/journeys.json`, the most valuable unblocked one first. Start any path whose dependencies are met.
2. **Work on your own branch** in your own worktree, never a shared checkout: a T3 thread works in the one T3 made for it, or gets one with `t3_worktree_handoff`; elsewhere `git worktree add <path> -b <branch> origin/main`.
3. **Prove what was agreed.** Write the journey's test (`apps/customer/tests/real-app/<journey>.pw.mjs`, one test per step, checking what the step's words say). Choose the order; before merging, prove the acceptance criteria, the money invariants and the failure branches. Never change a step's words to fit the code. How: [`docs/agents/build-slice.md`](docs/agents/build-slice.md).
4. **Rebase onto latest `origin/main` once before your first push** (journeys test your head unmerged); then merge main only on a GitHub conflict, or when the seal holds your PR on a red main has since fixed; BEHIND alone never (the ruleset doesn't require an up-to-date branch). Main runs every journey after merging; a red there is fixed or reverted within 2 hours. Locally, run the tests beside your changes, never the whole suite or full gates (project-state#3912); a builder holding a box stack slot drives its change from the menus (`verify-intafaced`). The Real-app journeys run starts on each push to your PR, draft included, and runs what it touches: only that run on the PR's exact head proves a step. If you can't prove it, say exactly why: that is a gap, not a pass.
5. **The CI review is the one judge** of your diff (the owner's decisions above): answer each of its findings in the PR body, fixed or why not.
6. **Open the PR as a draft at your first push** from your own account (a `tests:` rewrite opens ready); once its CI is green, `gh pr ready <n>`, then `gh pr merge <n> --auto --squash`; a PR that builds or rewrites a journey arms only once the `proof v2 read` status on its exact head is in: a failed read is fixed and pushed first, and a finding the PR can't clear is named in its body. A **design change**, new screens or a change to the look customers see (not every UI element a journey needs), is labelled `design` and carries its look baselines in their own commit; it merges like any PR, on its checks and the independent review of those pictures. The body follows the PR template; a step the title names that is not green on the PR's exact head is named at the start of a line, outside code: `Left-or-replaced: <journey> #<n> #<n>`. A changed journey test whose steps the title doesn't name is judged on all of them; no line needed. One PR per concern, merged in pieces that are safe to undo.
7. **The required checks decide the merge** on the exact head (floor 5); nothing run by hand overrides a red.
8. **A red:** read it with `node tooling/ci/why-red.mjs <PR>`; its `REVIEW` verdict only means the seal waits for the CI review, which is nothing to fix. A plain error or failed assertion in your change: fix it. If it looks intermittent, re-run the failed jobs once: a test that then passes is flaky and gets an issue with an owner, opened with `node tooling/ci/open-flaky.mjs`, which sets its label; a test that fails again is real: fix it. A red in a package your PR doesn't touch, and that depends on nothing your PR touches, isn't yours: say so once in a PR comment and re-run once.

## Where a mistake costs more

- **Gate files** (`GATE_PATHS` in `tooling/scripts/gate-files.mjs`: CI and workflows, agent rule files, root build files, secret-scan lists, CODEOWNERS and the like) need the `CI review` job's PASS on the exact head, which the CI merge seal requires whatever the title says. A new or changed check shows it passes on a known-good state and fails on a planted fault.
- **Look baselines** (`<package>/look-baselines/<room>/`) need a `Baseline-change: <room> — <why>` line and the `CI review` job's PASS.
- **The `CI review` job** judges the diff against [`tooling/ci/ci-review/REVIEW.md`](tooling/ci/ci-review/REVIEW.md), read from `main`. A FAIL stands for that code: fix it and push. A change that carries out an owner decision cites its merged project-state `decision` PR as "project-state decision PR #N" on a line it adds (a comment by the code it changes); the review reads that PR's body from project-state and judges the change against his words, so no entry in `REVIEW.md` comes first. A change to `REVIEW.md` is judged on its merits like any change. A PR that changes only the CI review's or the seal's own code (`JUDGE_FILES`, `tooling/ci/judge-repair.mjs`) passes the seal when every other check is green on its exact head and the review PASSed it, even while the seal's later steps are broken. If its seal still has no verdict once its checks have finished, re-run the newest seal run on its head. There is no admin merge.

## Services

- Services never read each other's tables: they call through a record or an event ([`docs/agents/shape.md`](docs/agents/shape.md), rules 1 and 3). Consumers are idempotent.
- User-facing copy names no partner or model vendor (`pnpm scan:brand`). The one exception: Hyperliquid is named as the execution venue in the venue disclosure and the terms. Model vendors and every other partner stay unnamed.

## GitHub and git

- **On a 403 or 429 from GitHub,** stop the refused action; honor rate-limit resets; never bypass a refusal. Report the exact response. Don't retry in a loop, switch accounts or create a token; keep working locally. The one exception, `403 This workflow is already running` on a re-run, means wait for that run, then re-run.
- **Never delete a branch** or force-push someone else's. Remove only your own worktree (`git worktree remove <path>`, never `--force`), and stop the services you started.

## Where things are

Where each kind of thing lives across the factory, this repo included, is one map: INTAFACED/project-state `AGENTS.md`, "Where things live" (the product spec is there too, under `product/`). This list names only what is inside this repo.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the generated `docs/SERVICES.md`: apps, services, packages, ports, env, the money flow and how to run.
- [`docs/agents/shape.md`](docs/agents/shape.md): the one way to add a call, a feature, a piece of state, a UI part, a service's wiring or a list. Read it before adding any of them.
- [`docs/agents/build-slice.md`](docs/agents/build-slice.md): how to build a journey and prove it. [`CONTRIBUTING.md`](CONTRIBUTING.md): setup, worktrees, commits and the CI check names.
- [`tooling/agent-protocol/AGENT_PROTOCOL.md`](tooling/agent-protocol/AGENT_PROTOCOL.md): service shape. [`apps/customer/README.md`](apps/customer/README.md): where customer screens and rooms go.
- Rust lives in `crates/` (one Cargo workspace, toolchain pinned in `rust-toolchain.toml`): `pnpm rust:check` runs what CI's Rust job runs (format, clippy with warnings as errors, tests); `pnpm rust:fmt` formats.
- Each service's `README.md`: read it before you edit that service. Find code with `rg`.
