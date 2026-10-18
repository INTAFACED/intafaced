# Instructions for AI agents

INTAFACED is an exchange, a bank and a payments platform on one custodial ledger. Build it, check it yourself, and merge only through the rules below. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) says what is where.

## The product

1. The front end is React: `apps/customer` (Vite and React) and `apps/admin` (Next.js). Vue (`vendor/upstream-exchange/05_Web_Front`) is history. Never build on it.
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

1. Run the checks on your machine before you push: affected tests, typecheck, and `pnpm exec prettier --check` on every file you changed. Leave the GitHub ruleset and required checks to the owners.
2. GitHub enforces the merge rule. The ruleset on `main` requires `CI merge seal`, `Gitleaks` and `Dependency audit` to pass on the PR's head, and blocks force pushes and deleting `main`. Any red required check blocks; there are no accepted reds. Never bypass the ruleset, and never merge with an admin override.
3. Every PR also needs an independent review (a separate Claude session, not the author) that passed the same head. Merge once that review and the required checks both hold, or turn on auto-merge after the review passes.
4. A PR that changes a gate file (for example `tooling/ci`, `.github/workflows`, `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `tooling/agent-protocol`; full list: `GATE_PATHS` in `tooling/scripts/gate-file-guard.mjs`) needs a `ci:` or `gate:` title. Agent-rule files are never docs-only.
5. A merge is not a launch. Deploys, purchases, live credentials, real funds and outside contact need the owner.
6. On a 403 or 429 from GitHub, stop all GitHub calls and report the exact response. Do not retry in a loop, switch accounts or create a token. Keep working locally.
7. Never push `main`.

## Git

1. On a laptop, work in a worktree, never the main checkout: `pnpm wt <branch>` creates one in a `<checkout-folder>-worktrees` folder beside the checkout. A cloud thread already has its own checkout; work on its branch.
2. When your task is merged or handed off, stop any service you started, and on a laptop remove your own worktree with `git worktree remove <path>`. Never use `--force`.
3. Never delete a branch. Never run `pnpm wt:rm`, `pnpm wt:gc:apply` or `orca worktree rm`. Leave other agents' worktrees and running work alone.

## Skills and status files

1. This file wins over a skill that says to wait for a person.
2. Write no status boards and no tracker recooks; spend the session on the product.

## Where things are

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): apps, services, packages, money flow, how to run.
2. [`docs/adr/`](docs/adr/): settled decisions. [`docs/runbooks/`](docs/runbooks/): operations procedures.
3. [`tooling/agent-protocol/AGENT_PROTOCOL.md`](tooling/agent-protocol/AGENT_PROTOCOL.md): service shape and money-path rules. [`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md) is the original product spec. Where it disagrees with the code or this file, the code and this file win.
4. Current truth is this file, `docs/ARCHITECTURE.md` and the generated `docs/SERVICES.md`, plus `docs/adr/`, `docs/runbooks/`, `docs/refs/` (measured front-end references) and `docs/agents/`. Everything else under `docs/` is history: each file opens with a "Not current rules" banner, and `docs/archive/` is history too. [`docs/README.md`](docs/README.md) lists what is kept and why. Where an ADR or any other doc disagrees with this file, this file wins.
5. Issues, labels and domain notes: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`.
6. Active work and owners: open GitHub PRs and issues (`gh pr list` and `gh issue list` on a laptop; the GitHub tools in a cloud thread, where `gh pr` fails). `docs/TRACKER.md`, `docs/LIVE-LANES.md` and `docs/ops/claims` are history.
7. Services, ports and required env: the generated `docs/SERVICES.md`. Read the target service's `README.md` first.
8. Customer front end: a top-level screen whose id is in `apps/customer/src/app/screens.ts` goes in `apps/customer/src/screens/<id>/index.tsx`. Every other room goes in `apps/customer/src/features/<area>/`, routed from that area's routes file (`rooms.tsx` in money, `<Area>Routes.tsx` elsewhere); feature-registry status is proof state (blocked = reachable, not yet proven live), never visibility. The merchant portal is `apps/customer/src/features/pay/portal/`. Add a new screen id to `ScreenId` in `apps/customer/src/app/screen-types.ts` first.
