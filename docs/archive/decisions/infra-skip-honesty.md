# A skipped suite must not be able to look like a passing one

**Status:** accepted · 2026-08-03
**Applies to:** `pnpm verify`, `pnpm test`, CI, every suite that skips itself when its infrastructure is unreachable

---

## What happened

An agent ran `pnpm verify` three times and reported:

```
Tasks:    92 successful, 92 total
```

on run 2 — then refused to count it, correctly. Postgres had saturated under parallel load, the
two-second connect probe timed out, and every database-backed suite took its `describe.skip` branch.
Fourteen suites did not execute. Turbo counted fourteen successes, because across a process boundary
a vitest run that asserted nothing and a vitest run that proved the ledger balances are the same
event: exit code 0.

The number was **true**. It was also the sentence a human reads and stops reading. Several agents
lost time to this in one week.

## Why it was dangerous rather than merely untidy

Two properties compounded.

**The asymmetry.** `REQUIRE_EVM_CHAIN=1` made a missing chain loud. Postgres had `REQUIRE_POSTGRES`
in `packages/db`, but **six** suites had copied a private probe instead. Five of them probe Postgres —
svc-token, svc-pay, svc-p2p, svc-blueprint, svc-agents — and a sixth, `svc-pay/src/rails/evm-chain.live.test.ts`,
does the same thing to a JSON-RPC endpoint. Counting only the Postgres five (as the first draft of this
document did) undercounts the bug by exactly the suite that guards the on-chain payment rail:

```ts
async function reachable(): Promise<boolean> {
  const probe = postgres(URL, { max: 1, connect_timeout: 3, onnotice: () => undefined });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 2 });
  }
}
```

`catch { return false }`. No `postgresRequired()`. `REQUIRE_POSTGRES=1` and `CI=true` did nothing to
any of them, so a database hiccup on CI skipped them silently and CI went green.

Of the six, three are money paths in the strict sense (svc-token, svc-p2p, svc-pay's payment service),
a fourth is the on-chain payment rail, and svc-blueprint and svc-agents are identity/runtime paths.
"Five money suites" is the wrong count in both directions; the number that matters is **six suites
that could decline to run on CI and be counted as passes**, of which **four** are fixed here and
**two** are blocked (below).

**The gradient.** Contention causes timeouts, timeouts cause skips, and a skipped suite cannot fail.
So **the run gets greener the more loaded the machine is** — the conditions under which you most want
the tests to run are exactly the conditions under which they quietly do not. This is the same family
as the svc-ledger crash-loop (#431): a container keeps the environment it booted with, so the fleet
looked healthy until something recreated it. A green that means "did not run" rather than "passed".

## The decision

**Skipping stays. Invisible skipping goes.**

Deleting the skip guards was never on the table. A developer with no Docker must still get value from
the ~800 tests that need no infrastructure, and a `verify` that cannot be run on a laptop is a
`verify` that gets deleted within a day — leaving us with neither the tests nor the honesty. So the
fix is not friction; it is that the distinction between "passed" and "did not run" now survives into
the summary.

1. **One journal.** Every probe for an external dependency writes a record — `ran`, `skipped`, or
   `required-failed` — into `.intafaced-run/infra/` (gitignored, per-worktree, one file per record so
   twenty parallel vitest processes need no lock). `packages/db/src/infra-journal.ts`.
2. **One probe per dependency.** `postgresAvailable` (`@intafaced/db`) and `devChainReachable`
   (each service's `scripts/`). Four of the six private probes are gone; they now call the shared one,
   which throws under `CI` / `REQUIRE_POSTGRES=1` and journals either way. The other two are in
   svc-pay, under the M1–M7 human lock — see below.
3. **A verdict that outranks the summary.** `tooling/ci/infra-verdict.mjs` prints, after turbo's line,
   either `✓ COMPLETE — every infrastructure-backed suite executed.` or a block naming each suite that
   did not run and stating that the run is **not green**. It will not print `COMPLETE` at all while
   `tooling/ci/unreported-suites.mjs` has entries: a suite that cannot journal is a suite the verdict
   has no evidence about, and claiming completeness over it would be this same bug one level up.
4. **A verify wrapper.** `pnpm verify` is `tooling/ci/verify.mjs`: same steps, same order, same exit
   codes — but the verdict prints **unconditionally**, including when an earlier step failed. Turbo
   halts on first failure, so a red `svc-trade` used to mean nobody ever learned what the rest of the
   run did or did not cover. `pnpm verify --continue` forwards the flag to turbo.
5. **A scan so it stays fixed.** `tooling/ci/skip-honesty-scan.mjs` fails the build if a test file
   decides whether to run using a connection it opened itself. This is the part that matters in six
   months: the private probes were not a mistake anybody made on purpose, they are what copying the
   service next door produces.

## The exit code, deliberately asymmetric

| Where                                               | A skipped suite           |
| --------------------------------------------------- | ------------------------- |
| Developer machine, no infrastructure                | prints loudly, **exit 0** |
| `CI` / `REQUIRE_POSTGRES=1` / `REQUIRE_EVM_CHAIN=1` | **exit 1**                |

On CI the probes throw first, which reds the suite before the verdict runs. The verdict is the
backstop for what they cannot cover: a suite whose own required-gate is narrower than the run's.

## What this does not fix

**Blocked behind the M1–M7 human lock.** svc-pay and svc-protocol may be read by an agent but not
edited, so nine suites keep their hole. They are not left to be rediscovered: each is an entry in
`tooling/ci/unreported-suites.mjs`, printed by `skip-honesty-scan` on every clean run and named in
every verdict, with an owner.

- **`svc-pay/src/payment-service.test.ts`** — a money suite still on a private Postgres probe. The fix
  is the same single line applied to svc-p2p in this change.
- **`svc-pay/src/rails/evm-chain.live.test.ts`** — two holes: a private JSON-RPC probe, _and_ a gate of
  `REQUIRE_PAY_EVM=1` that CI does not set, so it has skipped on every CI run there has ever been.
  Widening that gate is a decision about what CI must have running — svc-pay's to make.
- **Seven chain suites in svc-protocol** skip on `devChainReachable`, which is honest but silent:
  svc-protocol's copy of that helper does not journal, so the verdict cannot count them either way.
  svc-indexer's copy of the identical helper _is_ journalled here. Two of the seven skip the whole
  file and five skip a `describe` block — the register names all seven individually, because "the AMM
  on-chain suites" was how the first draft of it silently dropped five.

The register cannot rot. `skip-honesty-scan` fails if an entry stops violating or names a file that no
longer exists — so when CODEOWNERS fix one, the exemption has to be deleted rather than quietly
becoming cover for whatever lands on that path next.

Other limits:

- **A suite that never probes at all** cannot be journalled. The scan catches the shape that produced
  this bug (a private probe), not every conceivable one.

## Related

- `tooling/ci/test-db-scan.mjs` — a suite must own the database it points at. This is its sibling:
  when a suite decides **not** to point at one, it has to say so where the verdict can see it.
- `docs/decisions/local-dev-chain.md` — `REQUIRE_EVM_CHAIN`, the half of the asymmetry that was
  already right.
