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
   - INTACHAIN P1 is approved (owner decision 2026-10-17; ADR update in #4640, which supersedes the "implement parked" lines in `docs/adr/2026-09-03-protocol-rails-until-intachain.md`). `svc-chain`, INTACORE and Predict are @shehzad002's lane unless assigned. `/chain`, `/dex` and `/protocol` must be visible with honest labels. Never call Base INTACHAIN mainnet, and never set `audited: true` (the audit is external).
   - A new look is the owner's call: bring two or three rendered options traced to a measured reference.

## Money

1. Move value only through `packages/ledger-client` recipes (`packages/ledger-client/src/recipes`). Never assemble entries inline. There is one custodial ledger (`svc-ledger`) and no module holds its own balance.
2. Never store money in a `number`. Use decimal strings on the wire and scaled bigint in memory.
3. A second money book is out: no service-held balances, no outside system as source of truth, no second order book, no npm `ccxt`. Leave FIX, SBE and Greeks as adapters.
4. Idempotency keys are business keys (`deposit:crypto-native:0xabc`), never `randomUUID()`. Every money path tests its failure branches and has an invariant test. Ask: if this crashes exactly here, whose funds are stranded?
5. Protocol Plane services never import ledger write recipes (`pnpm scan:custody`).
6. Freezing one account belongs to `svc-identity`. The platform-wide posting freeze belongs to `svc-ledger`. Do not mix them up.

## Services and events

1. One service per pull request. If another open PR touches the same service or files, take a different part.
2. A cross-service change is two PRs in order: the `packages/contracts` or `packages/events` PR first, then the service PR.
3. Services never read each other's tables. Use tRPC through `packages/contracts` or an event. Publish only subjects declared in `packages/events/src/catalog.ts`. Consumers are idempotent.
4. User-facing copy names no partner or model vendor (`pnpm scan:brand`).

## Check, then merge

1. Run the checks on your machine before you push: affected tests, typecheck, and `pnpm exec prettier --check` on every file you changed. Do not add to or weaken the live GitHub ruleset on `main` (`CI merge seal`, Gitleaks, Dependency audit; no force-push, no delete; no bypass).
2. Merge only when both hold: the required checks are green on the exact head (the `CI merge seal` needs every job this PR's changed paths call for, Doctrine gates and the needed test shards included, to succeed; it does not tolerate a red), and `node tooling/scripts/merge-gate.mjs <pr> --head <sha>`, where a machine can run it (cloud threads cannot; they read the seal and the failing test names in the job's step title, apply item 3 by hand, and never merge on a red in a protected package the PR touches), run on the exact head from a clean, up-to-date `origin/main` checkout (not the PR's branch), passed or failed only on checks that item 3 accepts; and an independent review passed that same head. Every PR gets that review. What the gate (the tool) does: it waits for finished checks, requires Gitleaks and Dependency audit, blocks every red test shard (protocol, money, trade, pay-bank), blocks any other failing check that main's latest completed CI run does not share, and inside "Tests (full)" compares failing tests by name with main's last 5 completed runs. Inside "Tests (full)" it treats money and security packages like any other package. Item 3 is the stricter rule for them.
3. Accepted reds (the reviewer's rule; it decides whether a gate FAIL may still merge, and whether a red `main` blocks other work; GitHub's `CI merge seal` still needs green jobs, so an accepted red is re-run or fixed before the merge button works). Every failing check must be one of these: (a) `CX-8 assembled smoke` failing on "Sanctions screening list is unset"; (b) `CI merge seal` failing only because of other accepted reds; (c) a test failure whose test file also failed in at least one of main's last 3 completed CI runs, or that lives in a package the PR does not touch and that does not depend on a package the PR touches. For money or security code — `packages/ledger-client`, every package that depends on `@intafaced/ledger-client` directly, and `services/svc-edge`, `services/svc-ops`, `services/svc-protocol` and `services/svc-fix` — (c) applies only when the PR changes no file in that package; a red in a protected package the PR touches blocks the merge even when main shares it. Every other failing check blocks. The gate never merges: run the merge command separately. A PR that changes a gate file (for example `tooling/ci`, `.github/workflows`, `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `tooling/agent-protocol`; full list: `GATE_PATHS` in `tooling/scripts/gate-file-guard.mjs`) needs a `ci:` or `gate:` title and must pass main's copy of the gate. Agent-rule files are never docs-only.
4. GitHub itself requires the `CI merge seal` (which includes Doctrine gates), Gitleaks and Dependency audit to pass. A gate PASS does not override them. Never bypass them.
5. A merge is not a launch. Deploys, purchases, live credentials, real funds and outside contact need the owner.
6. On a 403 or 429 from GitHub, stop all GitHub calls and report the exact response. Do not retry in a loop, switch accounts or create a token. Keep working locally.
7. Never push `main`.
8. The independent review's PASS for the exact head sha is posted as a comment on the PR before you merge, in this form on its own line: `Independent review: PASS <full 40-character head sha>`. The `CI merge seal` fails without it; after posting, re-run that job.
9. `main` must stay green: a red `main` (other than the accepted reds in item 3) is fixed or reverted before any other merge.

## Git

1. Work on a branch in a worktree or your own clone, not a shared checkout; one PR per concern. Never push `main`. Never delete a branch. Never force-push someone else's branch.
2. When your task is merged or handed off, stop any service you started. If you used a git worktree, remove only your own with `git worktree remove <path>`, never `--force`. Leave other agents' work alone.

## Standing scope for agents

The owner's standing green light (2026-10-19): agents need no one's go-ahead for the work below, and should not stop to ask for it.

1. Allowed: push branches (`claude/*` or your task's branch) and open PRs; delete files and folders through a reviewed PR; merge a PR once the checks in items 2 and 3 of "Check, then merge" pass and the review comment from item 8 of "Check, then merge" is posted for the exact head.
2. Never, with or without a green light: force-push or delete `main`, touch secrets or keys, move real money, deploy money paths to production, or weaken a test or safeguard. These stay with the owner.

## Skills and status files

1. This file wins over a skill that says to wait for a person.
2. Write no status boards and no tracker recooks; spend the session on the product.

## Where things are

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): apps, services, packages, money flow, how to run.
2. [`docs/adr/`](docs/adr/): settled decisions. [`docs/runbooks/`](docs/runbooks/): operations procedures.
3. [`tooling/agent-protocol/AGENT_PROTOCOL.md`](tooling/agent-protocol/AGENT_PROTOCOL.md): service shape and money-path rules. [`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md) is the original product spec. Where it disagrees with the code or this file, the code and this file win.
4. Current truth is this file, `docs/ARCHITECTURE.md` and the generated `docs/SERVICES.md`, plus `docs/adr/`, `docs/runbooks/`, `docs/refs/` (measured front-end references) and `docs/agents/`. Material removed from the tree lives in git history. Where an ADR or any other doc disagrees with this file, this file wins.
5. Issues, labels and domain notes: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`. Active work and owners: open GitHub PRs and issues; use the GitHub tools or the GitHub UI.
6. Services, ports and required env: the generated `docs/SERVICES.md`. Read the target service's `README.md` first. Most services and apps, and some packages, also have a short `CLAUDE.md` that points back here.
7. Customer front end: a top-level screen whose id is in `apps/customer/src/app/screens.ts` goes in `apps/customer/src/screens/<id>/index.tsx`. Every other room goes in `apps/customer/src/features/<area>/`, routed from that area's routes file (`rooms.tsx` in money, `<Area>Routes.tsx` elsewhere); feature-registry status is proof state (blocked = reachable, not yet proven live), never visibility. The merchant portal is `apps/customer/src/features/pay/portal/`. Add a new screen id to `ScreenId` in `apps/customer/src/app/screen-types.ts` first.
8. Why the agent files look like this (checked 2026-10-19; the pages show no publish date, so this is our check date): keep each CLAUDE.md under 200 lines, because longer files cost context and adherence, and `@AGENTS.md` imports do not reduce that cost; subdirectory CLAUDE.md files load only when a file in that folder is read or edited ([Claude Code memory](https://code.claude.com/docs/en/memory)). The nearest AGENTS.md to the edited file wins ([agents.md](https://agents.md)); Codex layers root-down and stops at 32 KiB by default ([OpenAI Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)). Recheck these before changing the layout.
