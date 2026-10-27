# Instructions for AI agents

INTAFACED is an exchange, a bank and a payments platform on one custodial ledger. Build it, check it yourself, and merge only through the rules below. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) says what is where.

## The product

1. The front end is React: `apps/customer` (Vite and React) and `apps/admin` (Next.js). The old Vue front end was deleted; never reintroduce it.
2. Find code with `rg` and `rg --files`. Read the target service's `README.md` before you edit it. Start any product path whose dependencies are met without waiting for a tracker claim, an audit seal or a person.
3. Product law:
   - "Parked" means visible with the real blocker named. Never hide a room, route or control.
   - No "coming soon" screens. Every room gets its full layout and every control, with an honest empty or refuse state where its data or rail is not wired.
   - No fake balances, books, metrics or sample numbers. Label any illustrative figure TEST.
   - A blank price, limit, fee, sanctions list or provider setting stays blank: refuse with a typed error. Never invent live magnitudes.
   - INTACHAIN P1 is approved (owner decision 2026-10-17; #4640 replaces the "implement parked" lines of `docs/adr/2026-09-03-protocol-rails-until-intachain.md`). `svc-chain`, INTACORE and Predict are open to agents (owner decision 2026-10-22); @shehzad002 may take a part back by saying so on its issue or PR. `/chain`, `/dex` and `/protocol` must be visible with honest labels. Never call Base INTACHAIN mainnet, and never set `audited: true` (the audit is external).
   - A new look is the owner's call: bring two or three rendered options traced to a measured reference.
   - Customer rooms take their look only from `packages/ui` role tokens, never raw colours, pixel sizes or left/right sides (`.claude/rules/design.md`; `tooling/ci/look-drift.mjs` refuses them on changed lines; owner decision 2026-10-26).

## Money

1. Move value only through `packages/ledger-client` recipes (`packages/ledger-client/src/recipes`). Never assemble entries inline. There is one custodial ledger (`svc-ledger`) and no module holds its own balance.
2. Never store money in a `number`. Use decimal strings on the wire and scaled bigint in memory.
3. A second money book is out: no service-held balances, no outside system as source of truth, no second order book, no npm `ccxt`. Leave FIX, SBE and Greeks as adapters.
4. Idempotency keys are business keys (`deposit:crypto-native:0xabc`), never `randomUUID()`. Every money path tests its failure branches and has an invariant test. Ask: if this crashes exactly here, whose funds are stranded?
5. Protocol Plane services never import ledger write recipes (`pnpm scan:custody`).
6. Freezing one account belongs to `svc-identity`. The platform-wide posting freeze belongs to `svc-ledger`. Do not mix them up.

## Services and events

1. One service per pull request. Two open PRs may touch one service when their files do not overlap (owner decision 2026-10-20); if another open PR touches the same files, take a different part. `Main trust` stays the safety net: a breaking commit is reverted first.
2. A slice lands as one PR when it needs `packages/contracts` or `packages/events`, one service and that service's screen (owner decision 2026-10-22). Any other cross-service change is two PRs in order: the `packages/contracts` or `packages/events` PR first, then the service PR.
3. Services never read each other's tables. Use tRPC through `packages/contracts` or an event. Publish only subjects declared in `packages/events/src/catalog.ts`. Consumers are idempotent.
4. User-facing copy names no partner or model vendor (`pnpm scan:brand`).

## Check, then merge

1. Run the checks on your machine before you push: affected tests, typecheck, and `pnpm exec prettier --check` on every file you changed. A slice PR also proves its journey step in the running app before it opens (`pnpm local:stack`, Playwright on the machine's Chromium), and its body says what you did and saw, with the journey test's output (owner decision 2026-10-22). If the stack cannot start, say exactly why in the PR body: that is a gap to fix, not a pass. Once the PR is open, CI is the test run for its head: don't re-run locally the tests and typecheck it is already running there; read its result. Do not add to or weaken the live GitHub ruleset on `main` (`CI merge seal`, Gitleaks, Dependency audit; no force-push, no delete; no bypass).
2. Merge only when the required checks are green on the exact head. Every PR gets an automated code review (for example `/code-review`) before it is opened, and the PR body answers each finding: fixed, or why not; a money, security or gate-file PR also gets `/security-review`, answered the same way. A PR that changes money code (`packages/ledger-client` and every package that depends on it directly), security code (`services/svc-edge`, `svc-ops`, `svc-protocol`, `svc-fix`, `packages/auth`, `packages/config`, `packages/db`, `.github/`, the lockfile) or a gate file also needs an independent review of that same head (item 8), and so does a change to a look baseline (`<package>/look-baselines/<room>/`, named on a `Baseline-change: <room> — <why>` line; owner decision 2026-10-26); for every other PR the seal does not wait for item 8 (owner decision 2026-10-22). The seal decides this with the default branch's `tooling/ci/review-marker.mjs`. The seal needs the fast checks (Doctrine gates, format, typecheck and build) and the test job the changed paths call for; a skipped test job fails it unless the PR is docs-only. Before merge, tests run for the changed packages, their dependents and the readers in `tooling/ci/test-read-edges.json` (owner decision 2026-10-19); shared packages (contracts, events, ledger-client, config, auth), the lockfile, turbo or tsconfig files, `tooling/`, `.github/`, agent rule files and any path outside `apps/`, `services/` and `packages/` run everything, as does every run on `main`. Cloud threads read a red with `node tooling/ci/why-red.mjs <PR>`, which names the failing checks and their error lines, and open a job log only when it names nothing; its REVIEW verdict means the seal only waits for the independent review, which is nothing to fix. Nothing is run by hand to override a red.
3. A red is confirmed by one re-run of the failed jobs on the same head, never by a skip. A test that fails and then passes is flaky: it gets an issue with an owner (the `Main trust` workflow opens it for a run on `main`; on a PR, open it yourself and name the test file). A test that fails again is real: fix it. Never skip, disable, quarantine or weaken a test to get green. A red in a package the PR does not touch and that does not depend on a package the PR touches is not this PR's to fix: say so once in a PR comment and re-run once. For money code (ledger-client and its direct dependents) and `svc-edge`, `svc-ops`, `svc-protocol` and `svc-fix`, a red in a package the PR changes always blocks the merge, even when `main` shares it. `CX-8 assembled smoke` (not a required check) failing only on "Sanctions screening list is unset" is known. A PR that changes a gate file (`GATE_PATHS` in `tooling/scripts/gate-file-guard.mjs`; for example CI and workflows, agent rule files and protocol, root build files, secret-scan lists, CODEOWNERS) needs a `ci:` or `gate:` title and runs everything. Agent-rule files are never docs-only.
4. GitHub itself requires the `CI merge seal` (which includes Doctrine gates), Gitleaks and Dependency audit to pass. A gate PASS does not override them. Never bypass them.
5. A merge is not a launch. Deploys, purchases, live credentials, real funds and outside contact need the owner.
6. On a 403 or 429 from GitHub, stop all GitHub calls and report the exact response; the one exception is `403 This workflow is already running` on a re-run, which only means wait for that run to finish, then re-run. Do not retry in a loop, switch accounts or create a token. Keep working locally.
7. Never push `main`.
8. The independent review's PASS for the exact head sha is posted as a comment on the PR, in this form on its own line: `Independent review: PASS <full 40-character head sha>`, by a login in `tooling/ci/reviewers.json` (anyone else's counts for nothing); the `Review sign-off` workflow turns it into the `Independent review` status the seal requires, and re-runs a failed seal. The status carries over a clean rebase (same changed lines); any change to the patch needs a new review. The PASS never comes from the author's own session: a different session reviews (in a project, its review thread), and the comment names that session on a separate line. Turn auto-merge on from your own account when you open an in-repo PR, so a green, sealed head merges without a check-in and runs main's CI; a gate-file PR may too, with its fresh review and full run (owner decision 2026-10-20).
9. `main` must stay green: the `Main trust` workflow re-runs a red `main` once and, if it stays red, opens a `Main is red` issue naming the failing test files. Fix or revert the breaking commit before merging anything else that touches the same packages.

## Git

1. Work on a branch in a worktree or your own clone, not a shared checkout; one PR per concern. Never delete a branch. Never force-push someone else's branch.
2. When your task is merged or handed off, stop any service you started. If you used a git worktree, remove only your own with `git worktree remove <path>`, never `--force`. Leave other agents' work alone.

## Standing scope for agents

The owner's standing green light (2026-10-19): agents need no one's go-ahead for the work below, and should not stop to ask for it.

1. Allowed: push branches (`claude/*` or your task's branch) and open PRs; delete files and folders through a reviewed PR; merge a PR once "Check, then merge" items 2, 3 and 8 allow it for its exact head.
2. Never, with or without a green light: force-push or delete `main`, touch secrets or keys, move real money, deploy money paths to production, or weaken a test or safeguard. These stay with the owner.

## Skills and status files

1. Before you build or review a slice, read `docs/agents/build-slice.md`: how to build and review one. This file wins over it and over any skill that says to wait for a person.
2. Write no status boards and no tracker recooks; spend the session on the product.

## Where things are

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): apps, services, packages, money flow, how to run.
2. [`docs/adr/`](docs/adr/): settled decisions. [`docs/runbooks/`](docs/runbooks/): operations procedures.
3. [`tooling/agent-protocol/AGENT_PROTOCOL.md`](tooling/agent-protocol/AGENT_PROTOCOL.md): service shape and money-path rules. [`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md) is the original product spec.
4. Current truth is this file, `docs/ARCHITECTURE.md` and the generated `docs/SERVICES.md`, plus `docs/adr/`, `docs/runbooks/`, `docs/refs/` (measured front-end references) and `docs/agents/`. Material removed from the tree lives in git history. Where any other doc disagrees with this file, this file wins; where the original spec disagrees with the code, the code wins.
5. Issues, labels and domain notes: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`. Active work and owners: open GitHub PRs and issues.
6. Services, ports and required env: the generated `docs/SERVICES.md`. Most services and apps, and some packages, also have a short `CLAUDE.md` that points back here.
7. Customer front end: a top-level screen whose id is in `apps/customer/src/app/screens.ts` goes in `apps/customer/src/screens/<id>/index.tsx`. Every other room goes in `apps/customer/src/features/<area>/`, routed from that area's routes file (`rooms.tsx` in money, `<Area>Routes.tsx` elsewhere); feature-registry status is proof state (blocked = reachable, not yet proven live), never visibility. The merchant portal is `apps/customer/src/features/pay/portal/`. Add a new screen id to `ScreenId` in `apps/customer/src/app/screen-types.ts` first.
8. Why the agent files look like this (checked 2026-10-19, as the pages show no publish date; recheck before changing the layout): keep each CLAUDE.md under 200 lines, since longer files cost context and adherence and `@AGENTS.md` imports do not reduce that cost; subdirectory CLAUDE.md files load only when a file in that folder is read or edited, and only in local and Mac sessions: cloud project threads load the root `CLAUDE.md`, `.claude/CLAUDE.md` and `.claude/rules/` without `paths`, never a subfolder file ([Claude Code memory](https://code.claude.com/docs/en/memory); [Claude Code projects](https://code.claude.com/docs/en/claude-projects), checked 2026-10-26). The nearest AGENTS.md to the edited file wins ([agents.md](https://agents.md)); Codex layers root-down and stops at 32 KiB by default ([OpenAI Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)).
