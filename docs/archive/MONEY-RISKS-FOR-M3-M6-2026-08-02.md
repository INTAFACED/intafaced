# Three money risks inside M3 and M6 — for @shehzad002

**From an evidence-based audit run 2026-08-02 against `261b45a`.** All three are in your mountains, so they are yours to fix or to decline — I have deliberately not touched `services/svc-trade` or `services/svc-bank`.

**All three are blocked on CODE only.** No licence, no bank, no oracle, no chain. That is unusual on this platform and it is why they are worth doing ahead of new surface.

**None is exploitable today.** Each is prevented by a coincidence of current data or configuration rather than by a gate — which is exactly the property that makes them worth fixing before the coincidence changes.

---

## 1 · A futures position can be opened while liquidation is switched off

**M3.**

`TRADE_FUTURES_JOBS_ENABLED` defaults **false** (`services/svc-trade/src/env.ts:63`), so the liquidation and funding jobs never run. **There is no corresponding flag on opening a position** — `POST /api/v1/positions` (`private-rest.ts:630`) has no gate at all.

What saves us today is data, not code: all 16 listed markets are `kind='spot'`, and the `positions` table is not even migrated on the running fleet.

**The moment anyone lists a perp market**, a position becomes openable, fundable through real ledger margin recipes, and **unliquidatable until an operator sets an environment variable**. Nothing in the code would object.

**Suggested shape:** opening a position should require the same switch that runs the jobs which protect it. A risk engine that can take a position it cannot close is the wrong way round, and the fix is a gate rather than a policy.

---

## 2 · A loan accrues nothing and is never liquidated

**M6.**

`svc-bank` exposes five job endpoints (`index.ts:100,112,138,161,179`) and deliberately runs no in-process timer — a reasonable design. But **nothing in the repository calls them.** A repo-wide search returns only their own definitions plus a negative edge-routing test. There is no cron in `docker-compose.apps.yml`. And `LOAN_RISK_SWEEP_ENABLED` defaults **false** (`env.ts:106`).

So a borrower can draw principal and it sits forever: no interest accrues, no margin call fires, no liquidation happens.

**The loan implementation itself is excellent** — purposed collateral, event-sourced debt, per-(loan, day) idempotency enforced in the migration, a tiered liquidation ladder. All verified. **It is inert, not wrong.** The gap is that nobody schedules it.

---

## 3 · Margin calls are recorded as delivered, and are not delivered

**M6, and this is the one I would fix first.**

The margin-call sink defaults to `recordOnlyMarginCallSink`, a no-op (`loan-service.ts:231,261`), and `index.ts` passes no sink. So `send()` succeeds trivially — and the code then stamps `notified_at = now()` (`loan-service.ts:1182`).

Two consequences, and the second is the serious one:

1. An operator querying `notified_at IS NOT NULL` concludes borrowers were warned. **Nobody was.**
2. **A borrower is liquidated after a grace period that began with a notification they never received.**

A no-op sink is a fine default. **Stamping `notified_at` after a no-op is the defect** — the column should record delivery, not the attempt. `ops.notifications` already has the right posture to copy: `UnconfiguredChannel` **throws** `channel.not_configured` rather than returning a fake success.

> ### Correction — 2026-08-03. Read this before fixing consequence 2.
>
> The original text said the grace clock "runs off that undelivered call", which
> implied fixing `notified_at` would fix both consequences. **It will not.** The
> clock is a **different column, written earlier, by a separate statement.**
>
> - `loan-service.ts:1162-1166` sets `status='margin_call'` and
>   `margin_called_at = COALESCE(margin_called_at, now)` — this runs **before**
>   the `try { … send() }` block at `:1173` and is **not conditional on it**.
> - `loan-service.ts:1072` feeds `loan.marginCalledAt` into `planLiquidation`.
> - `risk.ts:430-434` computes `graceEnds` from `marginCalledAt`.
>
> So the liquidation clock is **`bank.loans.margin_called_at`**, not
> `loan_margin_calls.notified_at`. **These are two independent writes and they
> need two independent fixes.** Fixing only the stamp leaves the serious
> consequence entirely intact.
>
> Three further measurements, all verified:
>
> - **`notified_at` has zero production readers.** The only reader is
>   `loans.test.ts:1362-1366`, which asserts it is NOT null, in a test named
>   _"raises a margin call, records it, and delivers it"_. **The suite actively
>   pins the wrong behaviour green.**
> - **Insolvency waives grace entirely.** `risk.ts:428` —
>   `graceWaived = ltv >= policy.insolvencyLtvBps` (default 9500). Above that,
>   a loan is liquidated with no margin call and no grace at all. So "liquidation
>   only after a delivered warning plus grace" will not be universally true even
>   after a correct fix, and that carve-out looks deliberate.
> - **No service can currently ask svc-notify to deliver anything and learn the
>   outcome.** Every non-health procedure there is scoped to a user principal,
>   `ctx.service` is permanently null because the context is built without
>   `internalSecret`, and the only other ingress is the bus — which reports
>   acceptance, not delivery.
>
> And the margin-call event is **fully built on both ends and has never had a
> publisher.** `bankMarginCalled` is declared in the event catalog and
> svc-notify's consumer is complete — but nothing publishes it, and svc-bank
> depends on neither `@intafaced/events` nor `nats`, so the subject has never
> been produced. The sink signature also omits `calledAt` and `sequence`, both
> of which the event schema requires.
>
> The boot-log symptom this used to produce is **already gone, and the underlying
> gap is not.** svc-notify's consumer parked on this subject and logged a WARN on
> every boot from the day it shipped; that is no longer what happens. The event
> is now recorded in `WIRING_SOCKETS` (`packages/events/src/catalog.ts`) with a
> written reason, `tooling/ci/event-wiring.mjs` fails on any unwired event that
> is **not** recorded, and `index.ts:140-145` demotes a consumer parked on a
> declared socket to `info` — reserving `error` for a consumer that cannot attach
> and has nothing declaring why. **Do not read the quiet log as the fix.** The
> publisher is still missing, the socket entry says so, and wiring it in svc-bank
> is what closes it.

---

## Context that may be useful

**Main is not red.** The money core is **1,805 tests passing, 0 failing, 0 skipped** after a clean install. If you see failures like `recipes.marketMakerSeedFund is not a function` or a `number`/`bigint` money error in `venue-contracts`, that is a stale build, not a bug: `pnpm install --frozen-lockfile && turbo run build` clears all of it.

**`svc-trade` is 403/403 serially** but deadlocks under default file parallelism against the shared test database. Live flakiness, not a code defect.

**The running fleet is ~228 commits behind main** and has applied only 2 of 7 `trade` migrations. Anything judged by clicking the local stack is judging July 30.

---

## Not yours, being handled

`custody-scan` reading Java, the vendored datastore exposure (#409), the `apps/web` landing page, and the `APP_ENV` compose default are all mine and outside M1–M7.

Ask if you want any of the three above reassigned — they are in your lane, but there is no rule that says you have to take them.
