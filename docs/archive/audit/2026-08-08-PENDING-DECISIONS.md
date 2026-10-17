# Pending decisions — audit wave 2026-08-08

Tip: `5e03e0da`

Everything the 2026-08-08 audit wave found is either **fixed and merged** or
**parked with a reason**. This file is the parked half, gathered in one place so
nobody has to reconstruct it from fifteen findings files.

Nothing here is blocking. Each item says who it belongs to and what unblocks it.

---

## 1 · Two that need Nitro

### 1.1 `agents free on services/svc-trade` — unblocks a live money bug

`claim-check` reports `services/svc-trade` **human-claimed by @Nitro
(trade.mm-bot)**, and the gate's wording is "an agent must NOT implement here."
Reporting is allowed; implementing is not. So this was reported.

**The bug.** `packages/db`'s `amount()` promises `numeric(38,18)`. svc-trade's
`leverage` column ships `numeric(8,2)`. `leverage` is taken verbatim from the
request body, `parseAmount` accepts 18 decimal places, and the **un-rounded**
value computes `initialMargin` — which is posted to the ledger. Postgres then
rounds the stored `leverage` to 2 dp. The row's `leverage` and `margin_initial`
end up mutually inconsistent, and the API reports a leverage the money was not
sized with. The only constraint is `CHECK (leverage > 0)`: a range check, not a
scale check.

**This is the one finding in the wave where a live money path is currently
wrong.** Everything else is either fixed or fails closed.

**What unblocks it:** a comment `agents free on services/svc-trade`, or a human
taking it. The fix is a migration plus a schema-drift test — svc-ledger has one,
svc-trade and svc-pay have none.

**One untested link, stated honestly:** that `numeric(8,2)` _rounds_ `3.567`
rather than rejecting it is documented Postgres behaviour, read not run. ~95%.
`SELECT 3.567::numeric(8,2);` settles it, and the whole chain rests on it.

Detail: `docs/audit/2026-08-08-packages-contracts-db.md`.

### 1.2 Should the halted-module list be public?

`svc-edge` currently answers this **two contradictory ways**, and both are
deliberate code.

The CORS preflight ordering exists specifically so _"an unauthenticated caller
cannot read off which modules an operator has halted"_ — and it works, with a
test. The audit trail is likewise asserted operator-only because _"an incident
timeline is not public."_

Then `/ready` publishes `disabledModules` unauthenticated. It is a CORS surface,
it is exempt from the rate limiter, and compose publishes it on the host.

**Not a bug until somebody decides which answer is right.** If the list is
sensitive, `/ready` should stop carrying it; if it is not, the preflight
ordering is defending nothing and should stop claiming to.

Detail: `docs/audit/2026-08-08-svc-edge.md`, finding 5.

---

## 2 · Owner calls, not agent calls

| Decision                                                                                                                                                                                                                                                | Why it is not a patch                                                                                                                                                                                                               | Detail                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **A stolen access token survives up to 15 min past a confirmed compromise.** Refresh-reuse detection burns every session, but `verifyAccessToken` is stateless — `sid` is read by nothing that authorises and `jti` is consumed by nothing in the repo. | Three options at real cost differences; the thorough one spends the stateless-authorisation property the package is built on. A middle path — denylist only on the two direct-verify treasury surfaces — is written up. §9 owns it. | `packages-auth.md`         |
| **S2S body binding cannot be turned on.** `verifyServiceHeaders` takes a third argument carrying the mode; `edge.ts` passes two. `INTERNAL_SERVICE_BODY_BIND=require` changes nothing while an operator believes replay is closed.                      | An API change to `EdgeContextOptions` plus per-service wiring, flipping a security posture across seven services, two on a claimed mountain.                                                                                        | `packages-contracts-db.md` |
| **64 of 68 `.down.sql` files have never been executed**, against a §14 promise that migrations are "reversible **and applied in CI**". One is a comment plus `SELECT 1;`.                                                                               | The fix is a CI job that applies and reverses every migration — real CI minutes, and some reversals are genuinely impossible. Somebody has to define "reversible".                                                                  | `packages-contracts-db.md` |
| **A browser suite skips on every CI run and is invisible to all three honesty mechanisms** — it cannot journal, because `InfraDependency` has no `browser`. It is the only suite that proves CORS is enforced.                                          | Install playwright in CI (restores the proof, costs minutes) or journal the skip (cheap, closes the false green, restores nothing). A budget call.                                                                                  | `packages-contracts-db.md` |
| **The telemetry flush is fire-and-forget**, racing eighteen services' own `process.exit(0)`. The exposure is the final seconds before shutdown — exactly the window the docstring says matters.                                                         | Fixing it properly means awaiting shutdown _inside_ each service's teardown, i.e. a shape change to the package's public API. One decision, not eighteen patches.                                                                   | `packages-telemetry.md`    |
| **`edge.gateway` is a documented kill-switch that nothing reads.** The README promises a 503 from it; the repo's own test asserts the opposite in its title.                                                                                            | Deleting a documented operator control and building one are both product decisions.                                                                                                                                                 | `svc-edge.md`              |
| **The README says rate limiting does not exist. It exists and is on by default** — and compose sets no `EDGE_TRUST_PROXY` while nginx fronts the whole shell, so every caller shares one bucket.                                                        | The doc half is trivial; the deployment half is an operator call about topology.                                                                                                                                                    | `svc-edge.md`              |

---

## 3 · Two method notes, both paid for in this wave

**Read `origin/main`, never the working tree.** The main checkout runs ~250
commits behind. Reading `ci.yml` from it produced a phantom "CI regression" that
was caught only by re-deriving from the tip. Every claim in these files was read
via `git show origin/main:<path>`.

**A grep that cannot match is indistinguishable from a clean codebase.** A
float-money sweep used `\b` in `git grep -E`, which POSIX ERE does not support.
It matched zero and would have passed forever. Every negative result in this
wave was re-run with a positive control — and **that test is worth applying to
any CI scan in this repo**, because several of them are shaped the same way.

A third, smaller: a test fixture that is wrong in a _second_ way makes a real
vulnerability read as already-fixed. The `exp` bypass in `packages/auth` looked
absent until a probe showed the fixture had an invalid `tier` masking it.

---

## 4 · Where the rest lives

Fifteen findings files at `docs/audit/2026-08-08-*.md`, one per audited target,
each carrying promises checked, broken-and-fixed with the PR, broken-and-parked
with the reason, declared-never-emitted, executed-by-nothing, and the honest
negative result.

The negative results are not filler. "I attacked this and could not break it,
and here is specifically what I tried" is what stops the next session spending a
night on the same ground.
