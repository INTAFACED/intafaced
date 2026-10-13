# AGENT EXECUTION PROTOCOL

**Binding on every agent, every PR, every schema change. §15 of `INTAFACED_DEFINITIVE_BUILD.md`.**

---

## 0 · Before you touch anything

1. Read `INTAFACED_DEFINITIVE_BUILD.md`. It is the law, not context.
2. Read the target service's `README.md`.
3. Read this file.
4. Multi-dev: read `docs/COORDINATION-TRUTH-LAYERS.md` (or the coordination section in `AGENTS.md`). Auto-load on cold start — **full access**, no human permission gate.
5. Internet leverage: read `docs/INTERNET-LEVERAGE-LAW.md` before product code. Prefer Phase A in-repo assets (shell, ledger, `svc-*`). Named take/keep/never is north-star **§0.3** + `docs/BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md`. Mega backend v1.25: `docs/SPEC-BACKEND-MEGA-PLAN-2026-09-03.md`. Live-wire: `docs/SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md`. FIX/SBE/Greeks/WebAuthn/OpenAPI-from-Zod are **EXT adapters**, not vibe-code. Phase B `trade.ccxt-api` is an API **shape**; npm `ccxt` stays banned.

**Full access:** any agent may start any product path when deps are met. **Merge when done, once `node tooling/scripts/merge-gate.mjs <pr> --head <sha>` passes (AGENTS.md rule 2); a red main is not a blocker, a new red is.** Honor required branch-protection checks. A 403 or 429 from `gh` means stop. Do not retry in a loop, do not switch accounts, and do not create a new token. If an open pull request already touches that service, leave it and take a different part.

If the task is ambiguous, **the doctrine (§0) decides**. If still ambiguous, **ship refuse-closed** — do not stop to ask a human.

---

## 1 · Scope of a task

**One service per task.** A PR touches one `services/*` directory plus, at most, its own tests and README.

Cross-service work is **two PRs, in order**:

1. A `packages/contracts` and/or `packages/events` PR that declares the new interface or event. Reviewed on its own.
2. The service PR that implements against it.

Never the reverse. Never both at once. The contract is the design review.

---

## 2 · Hard prohibitions

These are not style preferences. A PR that does any of them is rejected without discussion.

| Never                                                                                             | Why                                                                                                                   | Instead                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Write raw SQL against another service's tables                                                    | §2 — services never import each other's schemas. The dev DB enforces this with per-service roles; production will too | tRPC via `packages/contracts`, or an event via `packages/events`                                                                                             |
| Move value outside `packages/ledger-client`                                                       | Doctrine §0.6 — ledger is law                                                                                         | Add a recipe in `packages/ledger-client/src/recipes/`                                                                                                        |
| Hold a balance in your service                                                                    | Doctrine §0.6 — no module holds its own balance                                                                       | An account kind in the ledger                                                                                                                                |
| Store money in a `number`                                                                         | 0.1 + 0.2 ≠ 0.3, and the book reconciles to 18dp                                                                      | `parseAmount` / `formatAmount`, `numeric(38,18)`                                                                                                             |
| Assemble ledger entries inline                                                                    | Recipes are the reviewable unit of a money path                                                                       | Call or write a recipe                                                                                                                                       |
| Publish an undeclared NATS subject                                                                | §10 — the bus is a contract                                                                                           | Add it to `packages/events/src/catalog.ts`                                                                                                                   |
| Name a partner or model vendor in user-facing copy                                                | Doctrine §0.7                                                                                                         | Identity Blueprint · Sovereign Intelligence · Neural Engine                                                                                                  |
| Import `ledger-client` write recipes from a Protocol Plane service                                | Doctrine §16.10 — provably non-custodial                                                                              | `ReadOnlyLedgerClient`, or reconsider the design                                                                                                             |
| Add a fourth shared system                                                                        | Doctrine §0.3 — Identity, Balance, Token. That is all                                                                 | Redesign. The need for a fourth means the design is wrong                                                                                                    |
| Leave a "temporary" anything                                                                      | Doctrine §0.1 — never half done                                                                                       | Finish it, or add a §13 socket entry and reference it in the TODO                                                                                            |
| Mark tracker `done` without path evidence / DoD                                                   | False product map                                                                                                     | Mountain event: `requires` + real proof; `pnpm tracker:check`                                                                                                |
| Require every craft PR to edit `features.mjs`                                                     | Speed tax — **not** the law                                                                                           | mountain events only (claim / handoff / done / optional wave note)                                                                                           |
| Rebuild product UI as a new SPA / second exchange kit while vendored shell is product law         | Internet leverage Phase A — V-SHELL is sole product UI                                                                | Craft/wire `vendor/upstream-exchange/05_Web_Front` + overlays                                                                                                |
| Adopt a second money book (Java balances as SoT, external ledger as SoT, service-held balances)   | Doctrine §0.6 + Phase A forbidden leverage                                                                            | `packages/ledger-client` recipes only                                                                                                                        |
| Invent mids/depth/prices so charts or books “look live”                                           | Honesty doctrine                                                                                                      | Real feeds or honest empty; see Phase A                                                                                                                      |
| Skip Phase A / full-horizon path and greenfield a domain that already has `svc-*` + shell surface | Rebuild tax; agents “forget leverage”                                                                                 | Read `docs/INTERNET-LEVERAGE-LAW.md` before first product edit                                                                                               |
| Adopt Hyperswitch (or peer PSP orchestrators) as pay connectivity                                 | D-S-10 ADR #769; Doctrine 5 no third-party connectivity lib in money path; orchestrator ≠ acquirer                    | Class X `socket.psp-partners`; thin relationship-backed adapters only                                                                                        |
| Share one migrate-on-startup test Postgres across concurrent agent worktrees                      | Contaminates peers; false reds (Denon #428 A/B)                                                                       | Dedicated test DB per branch / worktree                                                                                                                      |
| Leave an Orca desk / git worktree standing after you stop                                         | Sidebar fills with dead jobs; next agent spawns another                                                               | `git -C /Users/Nitro/projects/Sovereign worktree remove --force "$(pwd)"` if not home. Never `orca worktree rm` (deletes the branch). Never `git branch -D`. |

**Desk close-out (Orca sidebar).** A desk is the working folder under `sovereign-worktrees/` (one per job). A PR is GitHub — not the same object. Spawn with `pnpm wt` or Orca `worktree create`. When you stop, remove the **folder** from home as above. Keep the branch. Do not add a janitor daemon; unattended `pnpm wt:gc --apply --yes` is forbidden.

---

## 3 · Verify the change

Agents own technical review and verification. Run checks that exercise the changed behavior, including affected tests, relevant typecheck/build, and money invariants where applicable. Fix failures introduced by the change. Report unrelated baseline failures and checks that could not run; do not claim unverified behavior works. Full-suite CI and `pnpm verify` are informational. Required branch-protection checks still apply.

```bash
pnpm verify           # broad informational check; use affected checks for the change
```

`pnpm verify` is:

```bash
pnpm gates            # every entry in tooling/ci/gates.mjs (count is live; do not
                      # hardcode it here) — brand §0.7 · custody §16.10 ·
                      # secrets · vendor-shell · vendor-java-money ·
                      # dual-book door + door-paths · test-db isolation ·
                      # killswitch §14.6 · migrations §14 · workspace · tracker ·
                      # agent-autoload · path-collide/wt-gc self-tests · i18n (advisory)
pnpm format:check     # prettier
pnpm build            # turbo
pnpm typecheck        # no `any` escapes, no implicit widening
pnpm test             # unit + invariant suites
pnpm gate             # the full §14 Definition of Done, per service
```

**CI runs the same gate list from the same file** — `tooling/ci/gates.mjs`. That is deliberate: verify and CI used to keep separate lists and drifted, so two gates ran in CI and nowhere local. The file fails if `.github/workflows/ci.yml` stops calling `pnpm gates`, and fails if a scan lands in `tooling/ci/` that neither the list nor its documented exclusions claim.

A failure affecting the change must be resolved before that work is called done. Never weaken a correctness gate. Unrelated full-suite failures do not freeze independent work or verified merges.

Run the local checks when you can, with the scope and evidence above. Standard GitHub-hosted runner minutes are free on this public repo; service limits and acceptable-use rules still apply. Parallel pull requests stay, and agents still merge when done. Never weaken a gate. The old Actions spend throttle stays deleted. See [`docs/GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](../../docs/GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

A 403 or 429 from GitHub means stop GitHub requests and report the response, without a retry loop or a change of account or token. Share the refusal with other active agents; independent local work can continue. Resume a rate-limited request only after `Retry-After` or the exhausted limit's `X-RateLimit-Reset` time; if neither is supplied, wait at least 60 seconds before explicitly resuming. Resolve an account or permission restriction before resuming. Keep code work parallel, pace GitHub API requests, and avoid repeated status polling. See [GitHub's API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

The live external market-data smoke runs manually. Actions must serve this repository's development, testing, deployment, or publication; operational market-data polling belongs on our own infrastructure. Respect third-party access rules. See [GitHub's Actions terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features).

---

## 4 · Writing a service

Follow `tooling/agent-protocol/SERVICE_TEMPLATE.md`. The shape is not optional — uniformity is what lets an agent work in `svc-pay` on Monday and `svc-academy` on Tuesday without re-learning anything.

```
services/svc-<name>/
├── README.md              # API contract · Events · Ledger recipes (required by §14)
├── package.json
├── tsconfig.json
├── drizzle.config.ts      # from drizzleConfig({ schema: '<name>' })
├── drizzle/               # migrations + .down.sql reversals
└── src/
    ├── index.ts           # boot: env → db → bus → tracing → server
    ├── env.ts             # serviceEnvSchema + this service's own slice
    ├── db/schema.ts       # drizzle tables — THIS SERVICE'S SCHEMA ONLY
    ├── router.ts          # tRPC router, implements the contract type
    ├── events.ts          # publishers and consumers
    └── <domain>/          # the actual work
```

---

## 5 · Money paths

A "money path" is any code that leads to `ledger.post()`. It carries stricter rules:

- **≥ 95% unit coverage.** Not aspirational — measured.
- **Every recipe has an invariant test.** Sum-to-zero, no negative available, no stranded funds on any branch.
- **Every failure branch is tested.** Insufficient funds, rail failure, dispute resolution, partial fill, cancel-during-fill.
- **Idempotency keys are business keys.** `deposit:crypto-native:0xabc`, never `crypto.randomUUID()`. A retry must find the original.
- **Trace attribute `intafaced.money_path=true`** so the collector never samples it away.

Ask of every money path: _if this crashes exactly here, whose funds are stranded?_ If the answer is anyone's, the design is wrong.

---

## 6 · Events

- Subject: `intafaced.<service>.<entity>.<verb>`. Past tense. Declared in the catalog.
- Consumers are idempotent. Wrap with `idempotent(handler, store, scope)` — at-least-once delivery is the only delivery.
- Payloads are versioned. Breaking a payload = new version + both running until consumers migrate.
- Money amounts are decimal strings in payloads. Always.

---

## 7 · Jurisdiction and custody

Before serving any user-facing operation:

```ts
const decision = checkAccess({ module, plane, region, kycTier });
if (!decision.allowed) throw forbidden(decision.reason);
```

Or declare it on the procedure: `scopedProcedure('trade:write', { module: 'trade' })`.

**The sovereignty law (§22) is not a policy toggle — it follows custody:**

- Platform never holds the asset → permissionless. No KYC. No account gate.
- Platform holds the asset or touches fiat/card rails → tiered verification per the matrix.

If you find yourself writing a KYC check on the Protocol Plane, stop. Either the module is custodial and belongs on the Fiat Plane, or the check is wrong.

---

## 8 · Definition of Done

Product launch readiness is separate from merging a PR. Agents may merge their own verified changes and prepare previews; Nitro decides live launches. A merge does not authorize production deployment, live credentials, or real funds. The product readiness requirements below remain intact.

A module ships when `pnpm gate <service>` is green **and** the manual checklist it prints is signed. Not before.

Doctrine §0.1: _"A module ships when its Definition of Done passes — not before, and nothing 'temporary' survives to the next phase."_
