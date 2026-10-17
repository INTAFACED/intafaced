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
   - INTACHAIN P1 is approved. `/chain`, `/dex` and `/protocol` must be visible with honest labels. Never call Base INTACHAIN mainnet, and never set `audited: true` (the audit is external).
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

1. Run the checks on your machine before you push: affected tests, typecheck, and `pnpm exec prettier --check` on every file you changed. Do not add GitHub rules or required checks.
2. Merge only when both hold: `node tooling/scripts/merge-gate.mjs <pr> --head <sha>` passes on the exact head (run it from an up-to-date `origin/main` checkout), and the required independent review passed that same head. Money, security, sign-in and merge-check code need an Opus-class reviewer.
3. The gate never merges. Run the command it prints. A PR that changes a gate file (`tooling/ci`, `.github/workflows`, `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `tooling/agent-protocol`) needs a `ci:` or `gate:` title.
4. A merge is not a launch. Deploys, purchases, live credentials, real funds and outside contact need the owner.
5. On a 403 or 429 from GitHub, stop all GitHub calls and report the exact response. Do not retry in a loop, switch accounts or create a token. Keep working locally.
6. Never push `main`.

## Git

1. Work in a worktree, never the main checkout. `pnpm wt <branch>` creates one in the `sovereign-worktrees` folder beside the checkout.
2. When your task is merged or handed off, stop any service you started, then remove your own worktree with `git worktree remove <path>`. Never use `--force`.
3. Never delete a branch. Never run `pnpm wt:rm`, `pnpm wt:gc:apply` or `orca worktree rm`. Leave other agents' worktrees and running work alone.

## Where things are

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): apps, services, packages, money flow, how to run.
2. [`docs/adr/`](docs/adr/): settled decisions. [`docs/runbooks/`](docs/runbooks/): operations procedures.
3. [`tooling/agent-protocol/AGENT_PROTOCOL.md`](tooling/agent-protocol/AGENT_PROTOCOL.md): service shape and money-path rules. [`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md) is the original product spec. Where it disagrees with the code or this file, the code and this file win.
4. Every other file under `docs/` is history, not instructions.
5. Issues, labels and domain notes: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`.
