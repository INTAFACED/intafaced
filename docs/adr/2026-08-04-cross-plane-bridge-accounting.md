# ADR: cross-plane bridge accounting — the window cannot be closed, so it must be bounded

**Status:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-12. **Accounting law only** — the chain side is Shehzad's S-D7 / S-B5 and this does not reach into it.
**Ground truth:** `svc-bridge` **does not exist**. Not a shell, not a stub — zero lines, zero tables, zero procedures, zero tests, zero events. `bridgeBoundary()` is declared in `packages/ledger-client/src/accounts.ts:232` and has **zero callers** repo-wide, against 40 for `railBoundary`. There is no IFC contract on any chain: `grep -rn "IFC" services/svc-protocol/contracts/ services/svc-indexer/contracts/` returns nothing.

---

## The decision

> **A crossing cannot be one posting. The window between the two legs is unavoidable, and the spec's job is to bound it, name who is exposed inside it, and define the reversal — not to pretend it can be closed.**
>
> **And: the ledger's conservation check cannot see the chain. `totalsByAsset` returning zero is not evidence that supply is conserved across the planes, and must never be cited as if it were.**

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## Why one posting is impossible here

`loanLiquidate` established the repo's preference, and it is the right instinct: seize, sell and repay are **one** posting because the intermediate state is exploitable — "the window cannot be closed with a lock, because the lock is the thing being released."

That shape is **not available** to a bridge, and the reason is structural rather than a matter of effort:

- `assertBalanced` (`packages/ledger-client/src/client.ts:80`) checks sum-to-zero per asset **inside one Postgres transaction**.
- A chain credit cannot be an entry in that transaction.
- `LedgerClient` exposes exactly one write method, `post(request)`. There is no `begin()`/`commit()`, no two-phase commit, no cross-system wrapper. **The `PostRequest` is the transaction unit.**

So a crossing is necessarily two legs on two systems, and the `withdraw` precedent — hold, then settle **or** reverse — is the applicable one. Its window width is the chain's confirmation depth plus the attestation round trip. **Neither number exists anywhere in this repo for a bridge.** Naming them is the first thing D-S-12 implementation owes.

The governing question is already written, in `tooling/agent-protocol/AGENT_PROTOCOL.md:115`:

> **"Ask of every money path: if this crashes exactly here, whose funds are stranded? If the answer is anyone's, the design is wrong."**

A bridge cannot answer "nobody" at every instant. It must therefore answer **"the platform, and only the platform"** — the exposure lands on a treasury account that is allowed to run negative, never on a user.

---

## The reconciliation blindness — state this plainly, it is the most important fact here

The Fiat Plane's conservation check is genuinely strong. `reconcile.ts:5-19` runs three independent checks, and describes the third as:

> "`totalsByAsset` — every asset must net to zero across all accounts. **Catches value being created or destroyed by any means at all.**"

It is real, scheduled hourly, and self-freezes the whole book on failure. **And it is structurally incapable of noticing a bridge divergence.**

`totalsByAsset` sums every account including `treasury`, which is the only class allowed to run negative. Every posting is sum-to-zero per asset **by construction**. So a crossing that debits a user and credits `treasury/bridge:<chain>` nets to zero _regardless of what the chain did or failed to do_.

"Any means at all" means **any means that writes a row to `ledger_entries`**. An off-book chain mint writes no row. `totalsByAsset().IFC === '0'` stays true on the day an unlimited chain mint happens.

The one number that would matter — `-balance(treasury/bridge:<chain>, IFC)` compared against on-chain locked or minted supply — **is never computed**, because that account has never been written to and nothing in the fleet may read a chain balance and a ledger balance in the same place. `svc-protocol` and `svc-indexer` are both forbidden a ledger dependency, enforced by test.

`svc-pay` already wrote the definitive statement of this failure mode, about a different hole with the identical shape (`rails/posture.ts:22-28`):

> "Every invariant holds: the journal balances, the boundary account carries the obligation, the double entry is perfect. **The only thing missing is the money, and the only thing that would ever notice is a reconciliation against real custody — which is a job that runs later, if at all.**"

**A bridge inherits that gap at a boundary whose counterparty is a chain.** So:

**The cross-plane reconciler is not a later phase. It is the first deliverable, and no crossing may be enabled before it runs.** A bridge without it is a machine for making an unnoticed divergence permanent.

---

## The accounting law

### 1 · The obligation lives on `treasury/bridge:<chain>/<asset>`

`bridgeBoundary()` already exists and is already correct. A negative balance there is exactly the platform's obligation to the chain — the semantics `accounts.ts:215-222` gives every treasury seam. No new account class.

### 2 · Two postings, both keyed, with a defined reversal

`bridge.<direction>.hold:<crossingId>` then `bridge.<direction>.settle:<crossingId>` **or** `bridge.<direction>.reverse:<crossingId>`. Business keys, never a clock reading, never a UUID — the convention `bank.ts:46-50` states. Re-driving settles once.

**The reversal path is defined before the forward path is written**, exactly as `withdrawReverse` was. A crossing whose failure path is "improvise" is not a crossing.

### 3 · The exposure is the platform's, never the user's

At every instant of the window, the funds are either the user's or the platform's. There is no instant in which they are nobody's, and no instant in which a user's spendable balance reflects value that has left. This is what makes the unavoidable window survivable.

### 4 · Chain state is the authority, adapter memory is not

`svc-pay`'s crypto rail is the reusable precedent and its doctrine transfers verbatim (`crypto-native.ts:24-46`): `capture` is **derived from chain state** rather than from adapter memory, so a crash between the legs strands nothing and re-running produces the same answer.

**Under the confirmation threshold the answer is `pending`, never `settled`** — "a shallow transaction can still be reorganised away."

### 5 · A chain fact is not a chain fact until it is final

`svc-protocol/src/events.ts` publishes bus events **from the first log seen** — no confirmation wait, no finality depth, no block-hash check, no un-publish path if the log is orphaned. That is acceptable for observation and **must never** be a bridge's input.

`svc-indexer` has the real machinery — reorg unwind, parent-link checks, logs fetched **by block hash** (`chain/evm/source.ts:283-285`, whose header calls it "the single most important line in this file"). A bridge consumes a source with those properties or it consumes nothing.

Note also that no service anywhere uses `blockTag: 'finalized'` or `'safe'`; `finalizedHeight` is arithmetic, and `svc-indexer/src/env.ts:77-91` says outright that the depth "is NOT the correctness mechanism."

### 6 · Attestation is a §13 socket with a reserved name

Nothing exists — no attestor, no quorum, no multisig, no light client, and `merkle` appears nowhere in the repo. The event-subject grammar already reserves the verb `'attested'` (`packages/events/src/subject.ts:51`) with no publisher, so the naming slot is waiting.

Until an attestation design lands, **a crossing is operator-gated or it does not run.** Agents do not invent attestation security theatre — S-B5's own words, and they hold.

---

## Refuse cases

| Situation                             | Correct answer                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Chain source below confirmation depth | **`pending`.** Never `settled`. Never post the settle leg.                                 |
| Reorg orphans a credited log          | **Reverse posting**, keyed. The forward key must not be reusable to re-settle.             |
| Attestation absent or below quorum    | **Refuse the crossing.** Do not fall back to a single observation.                         |
| Ledger post fails after chain credit  | **Retry from chain state**, which is the authority. Never re-credit from memory.           |
| Chain credit fails after ledger debit | **Reverse.** The user is made whole; the platform carries the loss on the treasury seam.   |
| Reconciler cannot read one side       | **Halt crossings.** An unreadable side is not a balanced side.                             |
| Reconciler reports divergence         | **Halt and freeze**, on the pattern `svc-ledger` already uses. Never continue and alert.   |
| Replay of a settled crossing id       | **Idempotent no-op**, proven by test, not by a primary key that still performs its writes. |

---

## Non-goals

- **This does not design the chain side.** IFC's on-chain representation, mint-vs-lock, and the attestation set are **S-B3 / S-B5 / S-D7** and belong to Shehzad. This is the accounting law his implementation posts against.
- **This does not decide which L2 or rail.** That is S-D1 and this law is rails-agnostic.
- **This is not svc-pay's crypto rail.** `bridge.canonical.md:37` forbids the conflation and is right: a rail crossing moves value to an external counterparty, a bridge crossing moves the _same asset_ between two representations whose sum must be conserved.

---

## Done bar

1. The cross-plane reconciler exists and runs **before** any crossing is enabled. It compares `-balance(treasury/bridge:<chain>, asset)` against the on-chain figure, and halts on divergence. Spec of that first deliverable (job still unbuilt; no crossing): [`2026-09-18-cross-plane-reconciler.md`](2026-09-18-cross-plane-reconciler.md).
2. Every crossing is two keyed postings with a defined reversal, tested on both paths.
3. No user balance reflects value in flight. A test crashes between the legs and asserts whose funds are where.
4. Confirmation depth is a named number with a written reason, on the `crypto-native.ts:56-59` model — "this is the reorg risk budget."
5. A reorg that orphans a credited log produces a reversal, proven against a forked chain as `svc-indexer` already does.
6. `totalsByAsset` is never cited as cross-plane evidence, in code comments or docs.
7. No crossing runs without attestation or an explicit operator gate.

---

## What agents may implement without asking again

- The reconciler, and the halt-on-divergence path.
- The two recipes and their reversal, in `packages/ledger-client`, to the money law.
- A bridge posture endpoint reporting halted / behind / balanced.
- Consuming `svc-indexer`'s reorg-safe source rather than `svc-protocol`'s observation path.

## What still needs the owner

- **Register the bridge as a human blocker.** It is X1 by any reading and `docs/BOARD-CLEAR-HUMAN-BLOCKERS.md` (removed) does not mention it.
- The attestation design and its signer set — **zero of the keys a crossing needs exist today**.
- `jurisdiction.ts:135` sets `bridge: OPEN_FULL`, so a crossing already requires full KYC tier. That was decided silently; confirm or restate it deliberately.
- Any go-live. Class X1, and plausibly X3.

---

## Housekeeping this ADR notes but does not fix

- **Two research packs share one tracker id** — `docs/ops/trk/bridge.canonical.md` (removed) (155 lines, the superset) and `TRK-bridge.canonical.md` (114 lines, strictly smaller). Same duplication exists for `blueprint.attestations`, where the two actively contradict each other.
- Both packs say `owner: none`; `features.mjs:579` says `shehzad002`.
- The packs cite **S-B5** (design); the current board's build row is **S-D7**. Both are live — cite both.
