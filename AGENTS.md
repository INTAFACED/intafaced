# Agent rules

This file is the one set of rules. The map of the tree is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). If `INTAFACED_DEFINITIVE_BUILD.md`, an older ADR, or a service README disagrees with this file or with that map, follow this file and the code it cites.

Checked against commit `425647517` on 2026-10-16.

## What you change

Build the product in the module [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) names for that capability. The customer screen is `apps/customer` (React 19, Vite). Compose service `vendor-shell` builds `apps/customer/Dockerfile` and publishes `:8090` (`docker-compose.apps.yml:1774`, `:1780`, `:1789`).

The Vue tree at `vendor/upstream-exchange/05_Web_Front` stays on disk and is not served (`docker-compose.apps.yml:1741`). Do not craft it. `apps/web` is not in the tree. `apps/admin` is the operator console. `apps/invitation` is the public join app and is not a compose HTTP process. `apps/mobile` wraps the React customer build (`apps/mobile/package.json:6`, `apps/mobile/scripts/build-wrap.mjs:3`).

Shell composition that still stands:

- One signed-in frame. New screens render into `main`. One toast host for the app (`apps/customer/src/app/Shell.tsx:9`).
- A feature the customer should not see yet is a `hidden` row in `apps/customer/src/app/feature-registry.ts`. Menus read that file.
- The browser stays on one origin. nginx sends `/api/` to `svc-edge:4000` and `/ws/` to `svc-ws:4014`, and deep links fall through to `index.html` (`apps/customer/nginx.conf:41`, `:47`, `:59`).
- Audience that still stands from the July law: pro trader workbench; retail uses Convert and is not the terminal default (`INTAFACED_DEFINITIVE_BUILD.md` §5.3, the audience clause). The UI may be replaced (`docs/adr/2026-10-02-redesign-may-replace-product-ui.md:9`).

## Money

1. Move value only through `packages/ledger-client`. The package says it is the only way any service touches balances (`packages/ledger-client/src/index.ts:2`). Add a recipe under `packages/ledger-client/src/recipes`. Do not assemble ledger entries inline. No module holds its own balance (July law §0 rule 6).
2. Never store money in a `number`. Decimal strings on the wire, scaled bigint in memory (`packages/ledger-client/src/index.ts:2` doctrine quote; `services/svc-trade/src/spot/matching-client.ts:13`).
3. `svc-ledger`'s `PostgresLedger` is the store (`services/svc-ledger/src/ledger/postgres-ledger.ts:63`). `MemoryLedger` is the in-memory spec the Postgres ledger matches, not a second production book.
4. Java must not credit a balance. `MemberWalletService.increaseBalance` throws (`vendor/upstream-exchange/00_framework/core/src/main/java/com/bizzan/bitrade/service/MemberWalletService.java:310`).
5. A protocol-plane service does not import ledger write recipes. The read type is `ReadOnlyLedgerClient` (`packages/ledger-client/src/client.ts:51`). `tooling/ci/custody-scan.mjs` flags a writable import on that plane.
6. A blank price, limit, or sanctions list stays blank. Refuse that action with a typed error. Do not invent a live price, a mid, or a balance (`docs/adr/2026-10-02-redesign-may-replace-product-ui.md:14`).
7. Idempotency keys are business keys, not random UUIDs. A retry finds the original.
8. A money path asks: if this crashes here, whose funds are stranded? If the answer is anyone's, the design is wrong.
9. Every failure branch of a money path is tested: insufficient funds, rail failure, dispute resolution, partial fill, and cancel-during-fill. Every recipe has an invariant test: sum-to-zero, no negative available, no stranded funds on any branch.
10. Measured money-path unit coverage is at least 95%. July law §14 item 2 still states that bar and the recipe-invariant bar (`INTAFACED_DEFINITIVE_BUILD.md`). This file carries both. July law §14 item 3 (happy path plus the top three failure paths) is the weaker e2e line and does not replace rule 9.
11. A ledger post sets the trace attribute `intafaced.money_path=true` so the collector does not sample it away (`services/svc-ledger/src/tracing.ts:21`; the collector keys on `intafaced.money_path` in `tooling/infra/otel-collector.yaml`).
12. A second money book is out.
13. npm `ccxt` stays uninstalled. No `package.json` in this tree depends on it (searched 2026-10-16). The public exchange shape lives in `packages/exchange-contract`. That shape is not the npm package.
14. Do not add a second matcher. The house book is `services/svc-matching`. `services/svc-matching-rust-stage1` is a socket and says the TypeScript engine remains the default (`services/svc-matching-rust-stage1/src/lib.rs:4`). It is not a compose service. `SovereignVenue.sol` is a protocol-plane book and `audited` stays false (`services/svc-protocol/contracts/venue/SovereignVenue.sol:9`). INTACORE and `services/svc-chain` are not in the tree.
15. Hyperswitch stays out of the money path. `services/svc-pay/src/psp-mode.test.ts` refuses that package name.
16. FIX (`services/svc-fix`), SBE (`packages/sbe-codec`), and Greeks (`packages/greeks-adapter`) stay adapters.

`svc-trade` allows and funds a spot order, `svc-matching` matches it, and the ledger posts the fill (`services/svc-trade/README.md:5`, `services/svc-matching/README.md:3`). Order words live in `packages/exchange-contract`. Do not import `svc-matching` source from another service; `svc-trade` calls it over HTTP (`services/svc-trade/src/spot/matching-client.ts:7`).

## Planes

Trading stays on the house book. INTACHAIN stays parked until Nitro writes GO (`docs/adr/2026-09-03-protocol-rails-until-intachain.md:13`). Do not start `svc-chain` or P1. Base work that already exists may continue.

Custody follows who holds the asset (July law §22, `INTAFACED_DEFINITIVE_BUILD.md:584`):

- The platform never holds the asset: permissionless. No KYC on that path.
- The platform holds the asset or touches fiat or card rails: tiered verification.

Do not put a KYC check on the protocol plane. Either the module is custodial and belongs on the fiat plane, or the check is wrong.

Before a user-facing operation, call `checkAccess` (`packages/config/src/jurisdiction.ts:671`) or declare the procedure with `scopedProcedure` (`packages/contracts/src/trpc.ts:140`). July law §9 still says every module checks the matrix.

## Ship (full access)

1. One service per pull request, plus that service's own tests and README. Cross-service work is two PRs: first `packages/contracts` and/or `packages/events`, then the service. Never the reverse. A new service follows `tooling/agent-protocol/SERVICE_TEMPLATE.md`. The shape is mandatory.
2. Services do not import each other's database schemas. Cross-service calls go through `packages/contracts` or `packages/events` (July law §2, the rule under the layout).
3. Do not publish an undeclared NATS subject. Add it to `packages/events`. Subject shape: `intafaced.<service>.<entity>.<verb>`, past tense. Money amounts in payloads are decimal strings. Consumers are idempotent: wrap the handler with `idempotent(handler, store, scope)` (`packages/events/src/bus.ts:351`). A breaking payload is a new version, and both versions stay until consumers migrate.
4. Run the checks that exercise the change. `pnpm gates` is the list in `tooling/ci/gates.mjs`. Do not hardcode that count. `pnpm verify` is informational. Never weaken a correctness gate. Report unrelated baseline failures and checks that could not run. Do not claim unverified behavior works.
5. **Merge when done. Merge only after the merge gate passes.** Run `node tooling/scripts/merge-gate.mjs <pr> --head <sha>` from an up-to-date `origin/main` checkout, not from the PR branch. The gate never merges. Run the merge command it prints. A red main is not your blocker. A new red is. A pull request that changes a gate file needs a title that starts with `ci:`, `gate:`, or `chore(ci):`, or that includes `[gate-change]` (`tooling/scripts/gate-file-guard.mjs`). Agent-rule files are never docs-only (`tooling/scripts/merge-gate.mjs`).
6. Money, security, or auth work also needs an exact-head Claude Opus PASS before merge, until main's "Tests (full)" check has three consecutive green push runs (decision D-121, 2026-10-15). A self-audit does not replace that PASS. A red in code the PR touches blocks. `tasks/CI-flakes.md` is not in this tree (checked 2026-10-16), so a red cannot be excused by naming that file until the file exists.
7. Routine code does not wait for Nitro. An owner hold already set on a preview stays held until that owner clicks it. Do not turn that hold into a wait on every other pull request (decision D-125, 2026-10-16, is one such hold).
8. Never push `main`. `.githooks/pre-push` refuses a direct push. Trunk CI does not cancel an in-progress run on `main` (`.github/workflows/ci.yml:64`).
9. `audited: true` stays false until a paid external audit.
10. A module is shipped when `pnpm gate <service>` is green and the checklist it prints is signed (July law §0 rule 1 and §14). Do not leave a temporary path in place of that. Merging a pull request does not authorize a production deployment, use of live credentials, or movement of real funds. Nitro decides a live launch.

### Module done

Rule 10 is the module bar: `pnpm gate <service>` green, and the checklist it prints signed. A merge is not a live launch. When a session is finished is a different question (`docs/ops/FINISH-ONTOLOGY.md`). The same module bar is repeated in `tooling/agent-protocol/AGENT_PROTOCOL.md` §8 so older links still land on it.

### GitHub refusals

A 403 or 429 from `gh` means stop. Do not retry in a loop, do not switch accounts, and do not create a new token. Share the refusal with other active agents; independent local work can continue. Resume a rate-limited request only after `Retry-After` or the exhausted limit's `X-RateLimit-Reset` time; if neither header is supplied, wait at least 60 seconds before explicitly resuming. Resolve an account or permission restriction before resuming. Pace GitHub API requests and avoid repeated status polling. The same handling is repeated in `tooling/agent-protocol/AGENT_PROTOCOL.md` §3 so older links still land on it.

## Worktrees

Work in a worktree. Create one with `pnpm wt <branch>`. The directory is a sibling of the checkout, named from the repo folder (`tooling/scripts/worktree.mjs:33`). Bare `git worktree add` is the wrong start.

If an open pull request already touches that service, or the same files, leave it and take a different part. Several agents may work at once on different parts. Path-intersecting open pull requests are the check (`docs/COORDINATION-TRUTH-LAYERS.md`).

When you stop, remove the folder with `git worktree remove <path>` and no `--force` (decision D-119, 2026-10-15). Keep the branch. `git worktree remove` without `--force` refuses uncommitted edits.

Do not run `pnpm wt:rm` (it deletes a merged branch, `tooling/scripts/worktree.mjs:489`), `pnpm wt:gc:apply` (it runs `git worktree remove --force`, `tooling/scripts/worktree-gc.mjs:487`), `orca worktree rm`, or `git branch -D`. Branches are not deleted.

Use a dedicated test database per worktree. Do not share one migrate-on-startup Postgres across concurrent worktrees.

## What you write

Spend the session on the product. Do not write status boards, LIVE-LANES, or tracker recooks. A hard-to-reverse decision that has just settled may add one dated ADR under `docs/adr/`, matching the files already there. Do not start a `0001-` series. `GLOSSARY.md` is created at the root when the first term is settled (`docs/agents/domain.md`).

User-facing copy names Identity Blueprint, Sovereign Intelligence, or Neural Engine. It does not name a partner or a model vendor (July law §0 rule 7).

Graphify is retired. Do not install, query, or update it. No lockfile entry for it (searched 2026-10-16).

## Skills

Use the installed skills. This file wins where a skill says to wait for a person, wait for CI beyond the merge gate, or use `git worktree add`.

## Language

New product services are TypeScript. These already exist and stay: `services/svc-fix` (Java), `services/svc-protocol/contracts` (Solidity), `services/svc-matching-rust-stage1` (Rust socket, not the default engine). The July law's "TypeScript everywhere" line does not delete them and does not authorize a second matcher.

External rails sit behind internal interfaces. The platform does not depend on a named partner to boot (July law §0 rule 4).

Three shared systems only: Identity (`svc-identity`), Balance (`svc-ledger`), Token (`svc-token`). A feature that needs a fourth shared system gets redesigned (July law §0 rule 3).

## Links that stay

Issue tracker, triage labels, and domain-doc shape: `docs/agents/`. Coordination map: `docs/COORDINATION-TRUTH-LAYERS.md`. Pro-desk take, keep, and never list: `PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md` §0.3. **Internet leverage law:** `docs/INTERNET-LEVERAGE-LAW.md`. The July law remains the spec the coverage gate reads; its shell, layout, and "one language" sentences are corrected at the top of that file.
