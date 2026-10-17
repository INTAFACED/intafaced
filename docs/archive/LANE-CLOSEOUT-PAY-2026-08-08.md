# PAY lane closeout — 2026-08-08

Tip at writing: `f29ddf69`

This lane was dispatched to build nine `pay` mountains. It built none of them, and that was the right outcome. The harvest found three defects in already-merged code, one of which makes most of the nine unbuildable until an owner decision lands. Full detail: [`PAY-LANE-HARVEST-AND-BUILD-PLAN-2026-08-08.md`](PAY-LANE-HARVEST-AND-BUILD-PLAN-2026-08-08.md).

## Shipped

Nothing to product. One docs-only PR carrying this note and the harvest plan.

No code was written, no branch other than `docs/pay-lane-closeout` was created, no mountain was claimed, and `tooling/tracker/features.mjs` was not touched — it belonged to another lane this wave.

## Left open, and why

Nothing. This lane opened no product PR, so there is nothing red, drafted or dangling.

## Not started

All nine mountains. None was claimed and none was begun. Each is graded in §5 of the harvest plan with its real state, its honest slice and a size. Pick-up notes:

| Mountain            | Read first                                                                                                             | Note for the next session                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pay.settlement`    | `docs/adr/2026-08-04-pay-rails-and-psp-socket.md`; `docs/SPEC-PAY-VERTICALS-2026-08-02.md` §6 (done bar at `:109-112`) | Nearest to done of the nine. Crypto half ~85% built. Start with the two missing status guards below.                     |
| `pay.public-api`    | `docs/adr/2026-08-07-pay-public-api-law.md` §4; board `docs/ops/trk/pay.public-api.md`                                 | Steps 1–5 all merged, board row stale. One `BASE` constant fix away from working.                                        |
| `pay.routing`       | `docs/SPEC-PAY-VERTICALS-2026-08-02.md` §5 (`:90-99`) — **not** the tracker title                                      | Seam pre-cut at `services/svc-pay/src/rails/posture.ts:412`, five refuse-path tests already passing.                     |
| `pay.fraud`         | `docs/SPEC-PAY-VERTICALS-2026-08-02.md` §3 (`:60-70`); `packages/ledger-client/src/recipes/chargeback.ts`              | Chargebacks are the buildable part, risk scoring is not. Recipes exist and are tested; wiring them needs owner sign-off. |
| `pay.subscriptions` | `docs/SPEC-PAY-VERTICALS-2026-08-02.md` §4 (done bar at `:86`)                                                         | Transplant the scheduler from `services/svc-bank/src/transfers/` rather than designing one.                              |
| `pay.psp`           | `docs/SPEC-PAY-VERTICALS-2026-08-02.md` §1 (done bar at `:34`)                                                         | Two competing done bars. Do not start before that is ruled on.                                                           |
| `pay.gateway`       | tracker note in `tooling/tracker/features.mjs`; no spec section exists                                                 | ~90% built. Sequence its KYB wiring **after** a real approver exists.                                                    |
| `pay.payfac`        | `docs/SPEC-PAY-VERTICALS-2026-08-02.md` §2 (`:40-54`) — **no done bar in it**                                          | Blocked by `uniqueIndex('merchants_user_idx')`, not by `pay.psp`.                                                        |
| `pay.plugins`       | no spec section exists anywhere                                                                                        | Reclassify. Not three plugins — a decision doc and one reference client.                                                 |

Three of the nine (`pay.payfac`, `pay.plugins`, `pay.gateway`) have **no done bar in any spec**. They cannot be built to a bar that does not exist; writing the bar is the first task, and it is an owner call.

## Only Nitro can decide

1. **Who grants a merchant `pay:read` / `pay:write` / `pay:refund` / `pay:payout`, and after what check.** DIRECTION §8.4. All four are in `WITHHELD_FROM_SESSION` (`packages/auth/src/scopes.ts:265`) justified as _"granted by merchant onboarding"_, and no grant path exists anywhere in the codebase. The entire merchant surface is unreachable in production. Already recorded at `docs/DIRECTION-2026-07-31.md:88` as his alone. **Everything else in this lane is downstream of this.**
2. **Which done bar governs `pay.psp`** — the spec's rail-orchestration definition or the tracker's title. They describe different features.
3. **The 14 permission areas for `pay.payfac`** — enumerate or drop from the title. Never written down; the phrase exists only as a title string copied between six board files.
4. **Wiring the chargeback recipes.** `packages/ledger-client/src/recipes/chargeback.ts:10` carries an explicit owner sign-off banner, DIRECTION §3 Class M carve-out, four named questions. Merged unwired on purpose.
5. **The crypto-subscription contradiction.** `INTAFACED_DEFINITIVE_BUILD.md:607` promises recurring pull via user-granted allowances; `services/svc-protocol/src/session/spec.ts:41` forbids every selector that would implement it, at grant time. Amend the doc or open a §13 socket.
6. **`pay.gateway` tracker wording.** It can never reach bare `done`; its honest ceiling is `Done (crypto-native live; card absent — socket.psp-partners)`.

Blank DIRECTION §8 numbers found and deliberately not filled: settlement fee bps, pricing tier table, PSP/payfac fee splits, reserve and hold rates plus release dates, payout schedule and minimum payout, payout gas policy, per-rail cost for routing, risk thresholds and score cutoffs, chargeback fee, dispute representment deadline, decline-recovery retry ladder, fraud blocklist content, jurisdiction lists, merchant API rate-limit tiers.

## Defects found in merged code — none fixed, all fenced

Recorded here because they are live and none is mine to fix without a claim.

1. **The public payments API 404s for every external call.** `services/svc-pay/src/public-rest.ts:70` mounts at `/api/pay/v1`; the edge strips `/api/pay` before forwarding (`services/svc-edge/src/routes.ts:74`, `resolve()` at `:180`). All 11 public endpoints unreachable from outside; the first `curl` in our published quickstart does not work. Fix: `BASE` to `'/v1'`, keep the OpenAPI `servers` entry. Do **not** set `preservePath` — it would break `/api/pay/trpc` and `/api/pay/webhooks`.
2. **Suspending a merchant does not stop their money leaving.** `merchant.status` is checked only at `services/svc-pay/src/payment-service.ts:945` and `:1155`. `settleWindow` (`:1737`), `prepareSettlement` (`:1812`) and `payoutSettlement` (`:1933`) never read it. The `pay.gateway` tracker note claims otherwise in writing.
3. **No merchant can authenticate at all** — item 1 under "Only Nitro can decide".

Two stale tracker notes worth correcting when someone holds the file: `pay.rails` still names `MemoryBroadcastStore` as a production blocker (`PostgresBroadcastStore` exists at `rails/broadcast-store.ts:123`, migration `0004`, wired at `index.ts:88`); `pay.public-api` still describes steps 3 and 4 as pending (both merged, as did step 5 in #1024).

One free debt payoff nobody has taken: `tooling/ci/unreported-suites.mjs` lists `services/svc-pay/src/payment-service.test.ts` as a private-probe debt whose stated lift condition (_"LIFTS WHEN: #346 merges"_) was met on 2026-08-06. A one-line change to `postgresAvailable` plus deleting the entry unblocks `infra-verdict` from reporting COMPLETE.

## What I could not break, having tried

Honest negative results — places this lane went looking for a defect and found none.

- **The ledger money law holds.** `packages/ledger-client` has no `number` on any value path; `Amount` is `bigint`, `parseAmount` rejects anything over 18 decimal places and any non-decimal string, `formatAmount` is the only wire encoder, and recipes are pure functions with no I/O. `mulBps` defaults to `ceil` (house-favourable) and rounding is never implicit. No service holds its own balance — `merchant.balances` reads the ledger, not pay tables.
- **The settlement arithmetic is sound.** Two-phase freeze-then-post, `SELECT … FOR UPDATE` so concurrent runs queue, idempotency by unique index on `(merchant, window, asset)` with the asset in the key, a Postgres `settlements_conserved_ck` constraint enforcing `gross = fees + net`, and `numeric(38,18)` columns. Refuse paths are tested, including fee-exceeds-gross and the 1bps dust case.
- **The fee blank refuses correctly.** `PAY_DEFAULT_FEE_BPS` is optional with no default, on purpose, and settlement throws `pay.merchant_pricing_invalid` rather than settling at an unknown price. This is the pattern every other blank number should copy, and it already works.
- **Sandbox rails cannot reach live money.** `assertRailMayMoveValue` refuses `mode: 'absent'` ahead of every other check and before any ledger write; staging and prod refuse to boot while a sandbox rail is registered; a live key cannot be steered onto a sandbox rail, and absence is never upgraded to sandbox.
- **Cross-currency settlement is impossible, not merely unbuilt.** No FX exists on the money path; `quoteFx` is an optional port method no adapter implements. Settlement is single-asset by construction. The worst available failure in this vertical is currently unreachable.
- **The public REST auth and idempotency layer is genuinely well built.** Cross-merchant access is refused _before_ any mutation, `pay:refund` is a separate authority from `pay:write`, JSON-number amounts are rejected, replay returns the stored response verbatim and a same-key-different-body request is a 409. The one flaw is that nobody can obtain a key to use it.
- **Webhook signing is correct.** HMAC over the raw body bytes, not reserialised JSON; constant-time comparison; non-HTTPS endpoints refused; dedup by event id; a bounded retry ladder with a terminal dead state surfaced on a dashboard rather than silently dropped.
- **The merchant suspension audit trail is honest.** Append-only by database trigger, `actorId` taken from the principal and never from input, UPDATE and DELETE both refused, ordering by sequence rather than timestamp, and a test asserting there is no automatic suspension policy anywhere. Its own header refuses to hold one. The gap is not the trail — it is that suspension does not gate the outbound path.

## Housekeeping

- Worktrees created by this lane: one read-only worktree at `sovereign-worktrees/pay-tip-read`, detached, never committed to. It was already removed by another lane's prune before closeout; nothing was lost.
- Worktree remaining: `sovereign-worktrees/docs-pay-lane-closeout`, holding this PR. Remove after merge.
- No product branch was created, no PR of another lane was touched, and no uncommitted work remains.
