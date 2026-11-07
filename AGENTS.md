# Rules for agents

INTAFACED is an exchange, a bank and a payments platform. You own an outcome: build it, prove it in the running app, and merge it. This page is the rules; the linked files hold procedures. Where another file disagrees with this page, this page wins. Agreed acceptance criteria win; report conflicts.

## The floor

1. **Money moves only through `packages/ledger-client` recipes.** Never assemble entries inline. There is one ledger (`svc-ledger`): no module holds its own balance, and there is no second money book (no outside system as source of truth for what the ledger records, no second order book of our own, no npm `ccxt`; outside markets, users' own wallets, FIX, SBE and Greeks are reached through adapters). The ledger is authoritative for its own recorded obligations, never over a wallet's or an outside market's own state.
2. **Never store money in a `number`.** Decimal strings on the wire, scaled bigint in memory.
3. **Idempotency keys are business keys** (`deposit:crypto-native:0xabc`), never `randomUUID()`. Every money path tests its failure branches and has an invariant test. Ask: if this crashes exactly here, whose funds are stranded?
4. **Protocol Plane services never import ledger write recipes** (`pnpm scan:custody`). Freezing one account belongs to `svc-identity`; the platform-wide posting freeze belongs to `svc-ledger`.
5. **`main` stays protected and green.** Never push `main`. Never bypass a required check or change the `main` ruleset (`CI merge seal`, Gitleaks, Dependency audit; no force-push, no delete). A breaking commit is fixed or reverted before anything else merges into the packages it touches.
6. **Never skip, disable, quarantine or weaken a test or safeguard** to get green. A test that is wrong is fixed, with the evidence in the PR body. The one exception is the machine's: CI sets aside a journey step that fails and then passes on the same commit on main, for a limited time with an owner, and never a money step (`tooling/ci/journey-verdict.mjs`). No agent sets anything aside. A set-aside step never counts as proven.
7. **The owner alone:** deploys, real funds, live credentials, secrets and keys, purchases, and contact with anyone outside. A merge is not a launch.
8. **Honest product and honest claims.** No fake balances, books, prices, limits or metrics; an illustrative figure says TEST. A blank owner value (a price, limit, fee, sanctions list or provider setting) stays blank and refuses with a typed error; a labelled TEST value may stand in on test stacks only. A claim in a PR body comes with its output.

## The owner's decisions

Within the floor, these win over any agent's or reviewer's preference.

- **Standing green light** (2026-10-19): push branches, open PRs, delete files through a PR, and merge once the checks allow it. Nothing waits for a person.
- **One PR may carry one whole journey across services** (2026-11-06). Keep a journey together when it can be reviewed and reverted safely, money and security code included (2026-11-06, the owner's woke sweep).
- **Money, security and supply-chain code are reviewed like every other PR** (supply chain: `.github/`, the lockfile, `.npmrc`, `pnpm-workspace.yaml`, Dockerfiles, `.dockerignore`, compose files, `tsconfig.base.json`, `tooling/infra/`) until Launch hardening, the phase that must pass before any real money moves (2026-11-06). Gate files and look baselines keep their extra review.
- **The front end is React** (`apps/customer` with Vite, `apps/admin` with Next.js). Never reintroduce Vue.
- **Nothing is hidden.** Parked means visible with its real blocker named. No "coming soon": every room gets its full layout and every control, with an honest empty or refusal state. `/chain`, `/dex` and `/protocol` stay visible with honest labels. Never call Base INTACHAIN mainnet, and never set `audited: true` (the audit is external).
- **A journey marked parked** in `docs/roadmap/journeys.json` isn't built until it is unparked.
- **A new look is the owner's call at every step** (2026-10-24, 2026-10-25, 2026-10-27): measure the references first (`docs/refs/`), show rendered options built from them, and the owner chooses and decides when it ships. Customer rooms take their look only from `packages/ui` role tokens (`.claude/rules/design.md`; `tooling/ci/look-drift.mjs`; 2026-10-26).

## How work flows

1. **Own one outcome,** usually one whole journey in `docs/roadmap/journeys.json`, the most valuable unblocked one first. Start any path whose dependencies are met. Check active work once before editing; coordinate conflicting edits; independent changes in shared files are fine.
2. **Work on your own branch** in your own worktree or clone (`pnpm wt <branch>`), never a shared checkout.
3. **Prove what was agreed.** Each step's test (`apps/customer/tests/real-app/<journey>.pw.mjs`, one test per step, checking what the step's words say) is written by a test-writer who doesn't build the step, in a tests-only PR, under a `// Test-writer: <who>` line. The builder makes it pass and never loosens it (2026-11-06; `tooling/ci/test-diff-guard.mjs`). Choose the order; before merging, prove the acceptance criteria, the money invariants and the failure branches. Never change a step's words to fit the code. How: [`docs/agents/build-slice.md`](docs/agents/build-slice.md).
4. **Before you open a PR,** merge current `origin/main`. Run targeted checks while developing (affected tests, typecheck, `pnpm exec prettier --check` on changed files, and `node tooling/ci/gates.mjs`); let CI validate the pushed head; run full local suites only to diagnose. Prove the steps in the running app (`pnpm local:stack`, or a Real-app journeys run on the branch's exact head). A change to the journey stack's shared setup proves with the full journeys run. If you can't prove it, say exactly why: that is a gap, not a pass.
5. **Review your diff** with an automated code review (for example `/code-review`), and answer each finding in the PR body: fixed, or why not.
6. **Open the PR ready, with auto-merge on** from your own account. The body says what changed, why, the proof (commands and what you saw), which of the journey's steps are left or replaced (a step the title names that is not green on the PR's exact head is named on one line of the PR body, at the start of the line and outside code: `Left-or-replaced: <journey> #<n> #<n>`), and how to revert. One PR per concern, merged in pieces that are safe to undo.
7. **The required checks decide the merge** on the exact head: the `CI merge seal`, Gitleaks and Dependency audit. Nothing is run by hand to override a red.
8. **A red:** read it with `node tooling/ci/why-red.mjs <PR>`; its `REVIEW` verdict only means the seal waits for the CI review, which is nothing to fix. A plain error or failed assertion in your change: fix it. If it looks intermittent, re-run the failed jobs once: a test that then passes is flaky and gets an issue with an owner, naming the test file; a test that fails again is real: fix it. A red in a package your PR doesn't touch, and that depends on nothing your PR touches, isn't yours: say so once in a PR comment and re-run once. The required checks still decide the merge. For money code (`packages/ledger-client` and every package that depends on it directly) and `svc-edge`, `svc-ops`, `svc-protocol` and `svc-fix`, a red in a package your PR changes always blocks the merge, even when `main` shares it.
9. **Done is on `main`:** the journey's steps pass in the Real-app journeys run on `main`. `Main trust` re-runs a red `main` once and opens an issue when it stays red.

## Where a mistake costs more

- **Gate files** (`GATE_PATHS` in `tooling/scripts/gate-file-guard.mjs`: CI and workflows, agent rule files, root build files, secret-scan lists, CODEOWNERS and the like) need a `ci:` or `gate:` title, `/security-review` answered in the PR body, and the `CI review` job's PASS on the exact head. A new or changed check shows it passes on a known-good state and fails on a planted fault. Agent rule files are never docs-only.
- **Look baselines** (`<package>/look-baselines/<room>/`) need a `Baseline-change: <room> — <why>` line and the `CI review` job's PASS.
- **The `CI review` job** judges the diff against [`tooling/ci/ci-review/REVIEW.md`](tooling/ci/ci-review/REVIEW.md), read from `main`. A FAIL stands for that code: fix it and push. After three FAILs on one PR, rethink the approach. A change to `REVIEW.md` or to the review job can't pass its own review. When it only records a decision the owner has already made, in his words and dated, the factory-admin agent merges it with the owner's bypass once every other required check passes, and names the decision and its own thread on the pull request. Any other change to them waits for the owner.

## Services

- Services never read each other's tables. Use tRPC through `packages/contracts`, or an event declared in `packages/events/src/catalog.ts`. Consumers are idempotent.
- User-facing copy names no partner or model vendor (`pnpm scan:brand`).

## GitHub and git

- **On a 403 or 429 from GitHub,** stop the refused action; honor rate-limit resets; never bypass a refusal. Report the exact response. Don't retry in a loop, switch accounts or create a token; keep working locally. The one exception, `403 This workflow is already running` on a re-run, means wait for that run, then re-run.
- **Never delete a branch** or force-push someone else's. Remove only your own worktree (`git worktree remove <path>`, never `--force`), and stop the services you started.
- **No status boards or tracker recooks.**

## Where things are

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the generated `docs/SERVICES.md`: apps, services, packages, ports, env, the money flow and how to run.
- [`docs/agents/build-slice.md`](docs/agents/build-slice.md): how to build a journey and prove it. [`CONTRIBUTING.md`](CONTRIBUTING.md): setup, worktrees, commits and the CI check names.
- [`docs/adr/`](docs/adr/): settled decisions. [`docs/runbooks/`](docs/runbooks/): operations. [`docs/refs/`](docs/refs/): measured front-end references.
- [`tooling/agent-protocol/AGENT_PROTOCOL.md`](tooling/agent-protocol/AGENT_PROTOCOL.md): service shape. [`apps/customer/README.md`](apps/customer/README.md): where customer screens and rooms go.
- Each service's `README.md`: read it before you edit that service. Find code with `rg`.
- Issues, labels and domain notes: `docs/agents/issue-tracker.md`, `triage-labels.md`, `domain.md`. Active work and owners: open GitHub PRs and issues. The original product spec, `INTAFACED_DEFINITIVE_BUILD.md`, is private: INTAFACED/project-state `product/INTAFACED_DEFINITIVE_BUILD.md`.
