# svc-indexer — promise audit 2026-08-08

Tip: `c2e98cad` (audit baseline) · landed against `ff6b50c2`

Method: as for the other two — read the service's written promises and try to falsify each
against a reachable state.

**Provenance tags.** `[me]` = read on tip and traced myself. `[reported]` = surfaced by a
read-only harvest agent, not independently re-verified; a lead, not a fact.

The honest summary: reorg handling is the best-defended thing in this service and mostly
deserves its reputation — versioned-by-height state, unwind-by-deletion, a head-hash re-check
every pass, tested twice over against a really-forking chain. The weakness is not unenforced
promises. It is that **a frozen cursor can look identical to a healthy idle one**, which is
the exact failure the service's own header says it exists to prevent.

---

## Promises checked (58 README + 21 code-comment + 19 schema = 98)

| Outcome                                   | Count |
| ----------------------------------------- | ----- |
| VERIFIED                                  | 74    |
| BROKEN — parked                           | 8     |
| Documentation over-claim                  | 4     |
| Assertion present but effectively vacuous | 12    |

---

## Broken, fixed here

None. The reasoning is under I1 — the highest-value finding needs a test I could not write
honestly without a chain fixture this lane did not have time to build, and shipping the fix
without the test would be exactly the thing this audit exists to catch.

---

## Broken, parked

### I1 · An inconsistent chain source freezes the cursor with no error, no halt, and no alarm `[me]`

**Traced line by line on tip.** The ingest loop, per block:

1. Re-read the block at our own head and compare hashes. If it differs, repair.
2. If it matches, read the next block up. If its parent does not link to our head, repair.
3. Repair means: find the fork point, unwind above it, `continue`.

The fork search walks downward from our head comparing stored hash against source hash — and
**its first comparison is at our head height, the exact comparison that just succeeded in step
1**. So it returns our head immediately, the unwind deletes nothing, and the loop `continue`s
into an identical state.

The pass therefore spins to the batch limit (200 by default), applying nothing, orphaning
nothing, and — because nothing threw — the loop clears `lastError` to null on completion.

The resulting state: cursor frozen, `halted` null, `lastError` null, the chain probe reports
healthy, and the only thing that moves is `behindBy`, which nothing alerts on. Every two
seconds it burns four hundred RPC calls to achieve nothing.

That is precisely the state the file's own header says it exists to prevent — _"a frozen
cursor with no stated reason is the failure this service exists to prevent, arriving from
underneath it."_

**Reachability:** needs a source that answers consistently at height N and inconsistently at
N+1 — a load-balanced RPC fleet with a lagging member, or a proxy fanning out to two nodes.
Not exotic for production RPC. In a genuine reorg the head-hash check fires first and the
service self-corrects, which is exactly why no test catches this branch: every existing test
drives a real fork, and this branch only fires when the source disagrees with itself.

**Why parked.** The fix is not the hard part — the fork search should start below our head,
or the inconsistent-source case should be distinguished from the reorg case and raised rather
than repaired. The hard part is the test. Every reorg test in this suite drives a real anvil
chain, and a real chain cannot produce "consistent at N, inconsistent at N+1" — that requires a
deliberately lying source fixture, which does not exist here. I will not ship a change to the
reorg repair path with no test proving the behaviour, in the service whose entire value is that
its projection is correct at every depth. Building that fixture is the next session's first job
on this service, and the fix is small once it exists.

### I2 · A halted indexer serves its known-wrong book with no marker `[me]`

`halted` is read in exactly one place in the router — the `status` procedure. Not one data
procedure consults it. A halted, chain-unreachable or kill-switched indexer answers `book`,
`fills`, `accountFills`, `position` and `positions` identically to a healthy one.

The README's answer is that `/ready` returns 503 so the load balancer removes the instance —
but the edge forwards to a fixed compose-network address, not a readiness-gated pool, and the
503 path has no test at all.

Also: only `book` carries `asOfHeight`/`asOfHash`. A client holding a fills list cannot tell a
frozen cursor from a quiet market, because the newest row's height looks the same either way.

**Why parked:** the fix is a product decision — refuse, or annotate every response with
staleness — and it changes the shape of five public procedures. That is an API change and it
belongs in a deliberate PR with its consumers considered, not folded into an audit wave.

### I3 · A start height above the chain tip produces a permanently empty book that reports healthy `[reported]`

With an empty store and a start height above the tip, the first block read returns nothing,
the loop marks itself caught up and breaks. Nothing throws, so no error is recorded, nothing
halts, and the chain probe reports reachable with the venue deployed. Every read returns
empty, the market list is empty, and nothing anywhere says why.

The start-height config accepts any non-negative integer with no upper bound and no
cross-check against the tip — despite the boot sequence already performing a probe that knows
the tip.

**Why parked:** same class as I1 (silence where a reason belongs) and the same fix shape. Worth
doing together with I1 rather than separately.

### I4 · `behindBy` is unclamped and can report a negative number `[reported]`

After a deep chain revert the cursor sits above the tip and the lag figure goes negative. The
output schema is a plain integer with no lower bound. Separately, `behindBy` is null in two
semantically different situations — "no probe" and "empty index" — which a caller cannot
distinguish.

**Why parked:** small and safe, but it is the same surface as I2 and should ship with it.

### I5 · The one field that would explain "we are behind" reaches no surface `[reported]`

The sync result carries a flag saying the batch ran out before the chain head was reached —
the signal that would distinguish "behind because backfilling" from "behind because stuck". It
is set in four places and read by nobody. With a 200-block batch and a two-second poll, a
backfilling indexer is behind by design and the status endpoint cannot say that is why.

**Why parked:** part of the same status-surface change as I2 and I4.

### I6 · The ingest kill-switch is documented as an admin-console control and is not one `[reported]`

The README offers two ways to stop ingest: the admin console, or the environment variable.
Only the second exists. The flag registry classifies it as service-env — i.e. change the
variable and restart — and the admin console's own code states it has never read a service's
environment. The setter function has zero callers.

**Why parked:** repo-wide pattern already tracked by the kill-switch reachability tooling;
fixing one service in isolation makes it inconsistent with the rest.

### I7 · There is no gap detection `[me, by reading]`

The service has three linkage guards — the head-hash re-check, the forward parent link, and a
height echo on the RPC answer — and no completeness check. Nothing ever scans for a hole
between the earliest retained block and the head, and a restarted indexer trusts its stored
head without validating anything below it.

**Why parked:** this is a missing feature, not a broken promise. The README does not claim gap
detection. Recorded because the absence is worth knowing before someone assumes it.

### I8 · The entry point holds four load-bearing promises and is untested `[reported]`

The boot-time sovereignty refusal, the `/ready` 503 on halt, the missing-table refusal and the
two-source choice all live in a file that no test imports, and which is untestable as written
because it awaits a live database and starts listening at module scope.

**Why parked:** the fix is structural — extract an app builder, and all four become testable
at once. That is a refactor, and refactoring an entry point is not something to bundle into an
audit wave. Recommended as a standalone PR.

---

## Documentation over-claim

- **"`pnpm scan:custody` asserts it on every build"** — the custody scan is a CI gate, not part
  of `pnpm verify`, so a local build asserts nothing. `[reported]`
- **"the only interface it holds against a chain has exactly two methods and both are reads"**
  — the concrete EVM source also exposes a public, un-narrowed chain client, and a test already
  reaches through it. The service still cannot originate a transaction — there is no key
  anywhere and that half is solidly enforced — so this is an over-claim, not a custody hole.
  `[reported]`
- **"a test asserts the column types"** for every money column — one of six columns is
  asserted. `[reported]`
- **"132 tests"** — this one is exactly right, verified by count. Recorded because it is the
  only test-count claim in the three services audited today that was accurate. `[reported]`

---

## Assertions present but effectively vacuous

Worth its own section because it is the dominant weakness here and it does not show up as a
failing promise. Of seventeen declared refusal codes, only four are asserted by code; eleven
more are pinned only by a message regex, so any of those codes could be renamed or dropped and
the suite would stay green. One code string appears exactly once in the whole repo — nothing
anywhere matches on it. Three codes have no assertion of any kind. `[reported]`

The sovereignty test that guarantees no signing key can be added pins the env file with a
regex anchored to four-space indentation; a key declared at any other indentation is invisible
to it. `[reported]`

---

## Could NOT break, having tried

- **Logs are fetched by block hash, never by block number.** Enforced, and the test asserts it
  on the wire with a recording proxy, including a control proving the assertion can fail. The
  strongest test in the service. `[reported]`
- **Reorg repair.** The state tables are versioned by height, an unwind is a deletion above the
  fork, and orphaned blocks are kept rather than deleted. I looked for a way to make the
  projection wrong at some depth and did not find one. `[reported]`
- **The head-hash re-check every pass.** This is what catches the common reorg shape — a tip
  replaced without the chain extending — that any forward-only check would miss. Genuinely
  enforced, tested against a real forking chain, in both stores. `[me, by reading]`
- **Refusing rather than guessing on a too-deep reorg.** It throws, halts, and does not
  improvise a fork point below its retained history. `[me]`
- **Fills keyed on block hash, not height.** Two competing blocks at one height cannot collide
  their fills. `[reported]`
- **Levels and positions carry absolute state, never a delta,** so re-applying a block is an
  assignment and not an accumulation. `[reported]`
- **A zero-quantity level is removed rather than falling back to its old depth.** The filter
  sits outside the distinct-on, which is the whole correctness of that query, and the test is
  precisely targeted. `[reported]`
- **No key, no signer, no wallet client anywhere.** Verified by the env-shape test and an
  import audit. The non-custodial claim is structural, whatever the over-claim above says about
  interface width. `[reported]`
- **18 decimal places round-trip through Postgres unchanged.** `[reported]`
