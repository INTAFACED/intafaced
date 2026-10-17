# AFK residual STOP — overnight 2026-08-07 → 08 (second agent)

**Tip at writing:** `5392a62f` — `fix(ledger): one wedged query could hold the platform-wide posting lock forever (#1045)`
**Open PRs:** none besides this one (re-derived from `gh pr list`).
**Peer:** the other Nitro agent shipped the same night and posted `AFK-RESIDUAL-STOP-2026-08-07.md` at 23:22 (#1038).

Two agents ran overnight. This note is the second one's. Everything below is
re-derived from git and from CI runs, not from chat; where a claim could not be
checked tonight, it says so.

---

## 1 · What landed here

Ten PRs, each merged only after CI was green on it
(`git log origin/main --grep`):

| PR    | What it fixed, in plain terms                                                                  |
| ----- | ---------------------------------------------------------------------------------------------- |
| #1026 | Support agent can read the desk — and only ever the asking user's own ticket/account           |
| #1029 | A margin call that reached nobody left **no record at all** when the operator switch was off   |
| #1030 | `notify.channels` told a user email was available while sending was switched off               |
| #1035 | A margin call told someone with an **unconfirmed** number that they had no number              |
| #1037 | The new claim lease **acked** the margin call it was meant to protect                          |
| #1039 | The no-double-send guard was executed by no test anywhere — CI now runs it                     |
| #1040 | CI ran a NATS container for months that **nothing connected to** — and JetStream was off on it |
| #1042 | A bare `nak()` spent the whole retry budget in a few milliseconds                              |
| #1044 | **Value could exist in an asset the ledger had never heard of** (Class M)                      |
| #1045 | One wedged query could hold the platform-wide posting lock forever                             |

Seven of the ten are one failure class: **something the code promised in writing
that it did not do in some reachable state.** Most came out of two adversarial
audits run specifically to hunt for more after the first one — one over
`svc-notify`, one over `svc-ledger` and `ledger-client`.

`#1044` is the one to read first. Three separate files stated that a balance
cannot exist in an unregistered asset; nothing enforced it, so a one-character
typo opened a second complete book — balanced, non-negative, hash-chained,
reconciling, and unspendable, with nothing in the book to say it was there.

## 2 · Attribution — for the record

`AFK-RESIDUAL-STOP-2026-08-07.md` lists **#1030, #1035 and #1037** in its own
"landed this overnight wave" table. Those three came from this session. The
peer's own merges that night were #1031, #1032, #1033 and #1034.

No criticism of the work — only the record, and it is checkable per PR:
`gh pr view <n> --json headRefName` separates the two sessions by branch prefix.

## 3 · Findings raised on the peer's PRs (comments, not edits)

- **#1033 — claim lease.** Its `in_flight` branch returned `retryable: false`,
  which makes `events.ts` **ack** the message. With no sweeper over
  `notify.deliveries`, a lease holder that crashed mid-send left a margin call
  neither sent nor recorded as abandoned. Raised before it merged; merged
  unchanged; fixed in #1037.
- **#1034 — funding margin. OPEN, and it costs users money.** See §4.1.
- **#1040 follow-on.** CI's NATS was a `services:` container, which GitHub gives
  no way to pass a command, so it ran with JetStream **off** while
  `docker-compose.yml` has always passed `--jetstream`. Fixed in the same PR.

## 4 · Named residual — real, and NOT done

### 4.1 A money bug on tip that an agent may not fix

**`applyFundingNets` is not idempotent, and it sits on the retry path.**
`runFundingTick` does `postLegs` → `applyFundingNets` → `markSettled`. The
ledger post is idempotent; the row update is not; and `markSettled` — the guard
that stops a re-run — is written last.

A restart between the decrement and `markSettled` makes the next tick re-run the
period: the ledger correctly dedupes, and `margin_current` is decremented a
**second time** for the same funding period. The position then liquidates earlier
than it should and releases less collateral than is owed at close.
`GREATEST(..., 0)` clamps the error rather than surfacing it, so nothing throws.

Shape of the fix, in the comment on #1034: make the mutation idempotent on
`(position_id, period_id)` — the key that identifies the work — claimed and
applied in one statement so there is no second crash window.

**Why it is not fixed here:** `claim-check` reports `services/svc-trade` as
human-claimed by three owners (`@cursor-swarm-otc` / trade.otc, `@Nitro` /
trade.copy, `@shehzad002` / connect.venue-vault), and the gate's own wording is
"an agent must NOT implement here." Reporting is explicitly allowed; implementing
is not. **This needs Nitro's ruling** — either an `agents free on <path>` comment
or a human fix.

Related, same PR: `margins` is optional on `FundingTickDeps`. Production does
wire it (`futures-jobs.ts:120`), so the fix is live — but the Tier-1 defect it
closes returns silently for any wire that forgets it, with nothing at boot saying
so.

### 4.2 Worth a ruling: the claim gate was crossed

`services/svc-trade` is human-claimed as above, and **#1031 and #1034 both landed
in it** overnight. Stating it as a checkable fact, not as blame: if the gate is
meant to bind agents, something let two merges through it; if those trackers are
in fact free, `features.mjs` and the ownership docs disagree with reality. Either
way one of the two should move.

### 4.2b Ledger audit — seven findings left open, deliberately

The `svc-ledger` / `ledger-client` audit produced nine. Two are fixed (#1044,
#1045). The rest are recorded here rather than fixed, because each one turns on a
judgement that is a product or ownership call, not a correctness call, and
because three money-spine changes in one unattended night is already the limit of
what should land without a human reading it.

Ranked by what they cost:

1. **The purposed-lock rule has a database backstop for `hold` only.**
   `client.ts`'s `assertPurposedLocks` requires a purpose on all four lock kinds;
   the only CHECK is `accounts_hold_purposed_ck`. `accounts.ts` explains at
   length why an unpurposed `collateral` pot is the worst case — "releasing loan
   A's collateral could hand back value that was securing loan B: both postings
   balance, the journal reconciles, and loan B is quietly unsecured." Reachable
   only off the TypeScript path, which is the path the README says will exist.
   Same shape as #1044, and the same fix shape: a migration plus a raw-SQL test.
2. **`escrowRelease` is the one recipe left out of a guard applied four times
   elsewhere.** No bound on `feeBps` and no check that the buyer's leg is
   positive. At `feeBps: 10000` the buyer receives nothing; at `20000` the recipe
   emits a negative-amount entry (refused four layers down, so no money moves).
   A P2P trade at the rounding floor becomes permanently un-releasable — the
   seller can recover via `escrowRefund`, the buyer never receives.
   `tradeFill` already documents this exact failure class and guards against it.
3. **A freeze silently overwrites the previous freeze's reason and actor.**
   `writeFreeze` is a bare UPDATE with no `WHERE frozen = false`, and
   reconciliation calls it hourly. So a `reconciliation mismatch` freeze can be
   overwritten by a later operator freeze and vice versa — undercutting
   `posting_freeze_attributed_ck`'s stated purpose, "whoever finds the platform
   halted must be able to find out why and by whom."
4. **The two engines disagree on validate-vs-idempotency ordering.**
   `MemoryLedger` checks idempotency first; `PostgresLedger` validates first.
   Replaying a committed key with a body that would now fail validation returns
   the original transaction from one and throws from the other. Costs nothing
   today; it bites the first time a validation rule is tightened. The conformance
   suite — whose whole job is forbidding this — only ever replays a _valid_
   request, so the divergence is invisible to it.
5. **`assets.decimals` is documented as load-bearing and read by nothing.**
   Everything is stored and reconciled at 18 dp regardless, and `mulBps` rounds
   `ceil`, so fees on a 2 dp or 6 dp asset accrue sub-unit dust no rail can move.
6. **`subAccountHold` constructs an unpostable account** — `kind: 'hold'` with no
   purpose, which `assertValidPost` always refuses. Zero callers. Dead, and the
   same shape as the refusal code that was declared and never emitted (#1035).
7. **Freeze-event idempotency key is millisecond-precision** while the column is
   microsecond. Two state changes inside one millisecond collide on `msgID` and
   JetStream drops the second — which would be the _thaw_. Unproven; narrow.

**What the audit could NOT break, having tried:** double-entry balancing,
idempotency as a genuine no-op (three layers, including a re-check inside the
chain-tip lock), lock pairing and double-release, freeze ordering against posts,
`proRata` conservation including the negative-total case, and the
memory/Postgres conformance equivalence — which, unlike `svc-notify`, is
genuinely asserted rather than assumed.

### 4.2c A flaky test that will redden CI at random

`services/svc-p2p/src/instruments.test.ts` and `linear-pattern.test.ts` assert
**wall-clock** bounds (`expected 100.789375 to be less than 100`). Both failed
twice tonight under parallel load and both pass on a quiet machine. A timing
assertion on a shared CI runner is a coin flip, and the next person to see it red
will spend their time on a bug that is not there.

### 4.3 Blocked on verification not available tonight

- **No sweeper over `notify.deliveries`.** #1033 created `deliveries_lease_idx`
  and nothing queries it. A row can only be reclaimed by a bus redelivery; #1037
  keeps the message alive so that suffices today, but a row whose message has
  genuinely exhausted `max_deliver` sits `pending` with no process that will ever
  retire it. A periodic reaper is a new background job in a service that has
  none — a decision before it is code.
- **`PostgresNotifyStore` inbox dedupe and cursor paging** are still memory-only.
  #1039 wired the database and covered the delivery claim guard and the target
  verified/unverified split; the inbox store was not in scope.

### 4.4 Not agent-decidable

- **`NOTIFY_GATEWAY_TIMEOUT_MS` at its 30s ceiling breaks the lease bound.** The
  claim lease must exceed one gateway attempt and stay under the bus `ack_wait`
  (30s). At a 30s timeout those bounds cross and no lease length works. Written
  down at the constant in `channel-store.ts`; the fix is an operational limit on
  the timeout, which is an owner call.
- **Real out-of-app delivery** — gateway credentials are Class X. Every channel
  still refuses honestly; nothing pretends to send.

### 4.5 Deliberately not taken

- **`services/svc-academy`** — `claim-check` reports the whole path human-claimed
  by `@Nitro` under `academy.ambassadors`, so the four free academy trackers were
  left alone, even though `academy.paper-trading` has exactly one open Stage-2
  box ("optional progress hook to certs") that is otherwise ready to build.
- **The doc-only free claims** (`academy.*`, `agents.navigator`,
  `agents.scanner`) — their allowed-path lists contain only their own tracker
  file. Writing those is the stamp mill the swarm mandate bans.
- **Sixteen stranded branches**, 4–9 days old against a tip that has moved 250+
  commits. Rebase archaeology, not overnight work.

## 5 · For the next session

The productive move was not the free-claim list. It was **reading a service's own
written promises and checking each one against a reachable state.** `svc-notify`
documents its invariants unusually well, and four of them were false. That method
transfers: `svc-bank`, `svc-p2p` and `svc-ledger` carry the same style of
load-bearing comment and none has been audited this way.

Second: **two of the ten were "this is tested by nothing".** Worth asking of any
guard before trusting it — `svc-notify`'s Postgres stores and the entire
JetStream bus were both in that state, and both are money-adjacent.
