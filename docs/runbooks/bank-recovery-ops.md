# Runbook — bank recovery (pending loans, earn deposits, card settlements, auto-invest)

**Code:** `services/svc-bank/src/loans/loan-service.ts` (`abandonPending`, `resumePending`), `services/svc-bank/src/earn/earn-service.ts` (`resumePending`), `services/svc-bank/src/cards/card-service.ts`, `services/svc-bank/src/auto-invest/auto-invest-service.ts`, `services/svc-ledger/src/db/connection-options.ts`.
**Decision:** [`../adr/2026-10-14-recovery-lookup-first-no-expiry-yet.md`](../adr/2026-10-14-recovery-lookup-first-no-expiry-yet.md).
**Money law:** the ledger is the only book. Nothing below edits `ledger.*`. A ledger movement is always a posting through the operator door named in [`../ops/INCIDENT-MONEY-PATH-RUNBOOK.md`](../ops/INCIDENT-MONEY-PATH-RUNBOOK.md).

A bank money path writes a **claim row** first (`pending`), then posts to the ledger on a business key, then marks the row `settled`. If the reply to the post is lost, the row stays `pending` on its original terms and the ledger may or may not have booked it. The ledger never forgets a booked key, so a re-send can never double-book. The open question is always the same: **did the post commit?** Recovery answers it by asking the ledger (`getTxByKey`) before it does anything else.

## 1. The rule

1. **Look the key up first.** A booked key is adopted at any age: the record catches up, nothing is re-posted.
2. **Only an unbooked key may be re-sent or released**, and a release is allowed only when the ledger can no longer commit the original call (section 2.3).
3. **A definite refusal is final** (`ledger.insufficient_funds`, `ledger.invalid_entry`, `ledger.unbalanced`, `ledger.owner_identity_space`). Anything else (a timeout, a 5xx, an untyped body, `ledger.idempotency_conflict`) is an unknown outcome: the row stays `pending`, never `rejected`.

## 2. A pending loan (`bank.loans.status = 'pending'`)

A pending loan has its collateral lock posted (or claimed) and its draw not recorded. Find them (bank DB, read-only):

```sql
SELECT l.id, l.user_id, l.principal, l.debt_asset_id, l.opened_at,
       l.updated_at AS last_attempt_at,
       now() - l.updated_at AS since_last_attempt,
       e.status AS lock_status, e.ledger_tx_id AS lock_tx
  FROM bank.loans l
  LEFT JOIN bank.loan_collateral_events e ON e.loan_id = l.id AND e.sequence = 0
 WHERE l.status = 'pending'
 ORDER BY l.opened_at;
```

For a pending loan, `updated_at` is the **last post attempt** on the database clock. Every lock post and every draw post writes it just before the call goes out, and nothing else touches a pending row.

### 2.1 The recovery job: `ops.resumePendingLoans`

Per loan, in this order:

| Step | What it does                                                                                                                         | Outcome                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 1    | A collateral lock row that is `rejected` is final. Nothing is re-posted.                                                             | `failed`, reason `bank.loan_collateral_rejected`. Abandon the loan (2.2).                                              |
| 2    | Look up `bank.loan.draw:<loanId>`. Booked: adopt it. The loan goes `active`, `draw_ledger_tx_id` is set, and nothing is posted.      | `completed`                                                                                                            |
| 3    | Not booked: re-check the opening LTV on a mark no older than the price policy's `maxAgeSeconds` (300 s) and under the product's cap. | A stale or missing mark is `bank.mark_missing`, a breached cap is `bank.ltv_exceeded`. No draw is posted. `failed`.    |
| 4    | Checks passed: lock (replays if booked) and draw are re-posted on their original keys.                                               | `completed`, or a reserve error (`bank.loan_reserve_underfunded`) that leaves the loan pending with collateral locked. |

A loan that fails step 3 stays pending. It is the borrower's collateral price that moved, so decide with the borrower's interest in mind: abandon it (2.2) and let them open a new loan at today's price.

### 2.2 Abandon: `ops.abandonPendingLoan` (scope `admin:treasury`, action approval required)

Gives the collateral back and closes the loan, **only if the draw never booked**. In order:

1. **The draw key is looked up.** If it is **booked**, the loan is **adopted**: it becomes `active` with the draw's transaction, **no collateral moves**, and the loan is never marked repaid. The answer says `adopted: true` and `drawLedgerTxId`. (Before this change the door released the collateral anyway, which left the drawn principal unsecured.)
2. **Not booked, and the last attempt is less than 7 minutes old** (database clock): refused with **HTTP 409 / tRPC `CONFLICT`, code `bank.loan_attempt_too_recent`**, and the message says how many seconds to wait. Nothing moved. Retry after that time. As the door is written today it consumes the action approval before it calls the service, so a refused attempt uses its approval up: get a new one for the retry.
3. **Not booked, and the last attempt is older than 7 minutes:** the collateral is released, the loan is marked `repaid`, and `released` and `ledgerTxId` say what moved.

An `abandon` and a `resume` of the same loan cannot run at the same time: both take the per-loan advisory lock `bank.loan.open`, and each re-reads the loan after it gets the lock.

### 2.3 Why 7 minutes

The ledger can still commit a call after the caller gave up on it. "The key is not booked" is therefore only safe to act on once the original call can no longer arrive or finish. Four limits add up:

| Term                                                                                                  | Value | Where it lives                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| Caller's retry deadline: the last signed attempt can start this long after the timestamp was written  | 25 s  | `services/svc-bank/src/ledger-client.ts` (10 s per attempt, 2 retries, 25 s deadline)                        |
| A signed service call is refused once it is older than this, so a delayed request can start this late | 300 s | `SERVICE_CALL_MAX_SKEW_SECONDS` in `packages/contracts/src/service-auth.ts`                                  |
| One statement inside svc-ledger may run this long                                                     | 15 s  | `LEDGER_STATEMENT_TIMEOUT_MS` in `services/svc-ledger/src/db/connection-options.ts`                          |
| The posting transaction may sit idle between statements this long, then Postgres ends it              | 60 s  | `LEDGER_IDLE_IN_TRANSACTION_TIMEOUT_MS`, same file (added with this change; before it the term had no limit) |
| **Sum**                                                                                               | 400 s | rounded up to **7 minutes**: `LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS` in `loan-service.ts`                     |

The last three alone (300 s + 15 s + 60 s = 375 s) already exceed six minutes, which is why the bound is seven and not six. If any of the four limits changes, change the constant with it. A test pins the ledger's idle limit and a test per side of the bound pins the behaviour.

**Until svc-ledger with the idle-in-transaction limit is deployed, the 60 s term is a hope, not a limit.** Do not abandon a loan on the bound alone in that window if the ledger is unhealthy: check the ledger for long-running transactions (`pg_stat_activity` where `state = 'idle in transaction'` in the ledger database) first.

## 3. A pending earn deposit (`bank.earn_positions.status = 'pending'`)

`ops.resumePendingEarn` re-posts the deposit on `bank.earn.deposit:<positionId>` and activates the position.

- Booked or accepted: the position becomes `active`.
- **Definite ledger refusal** (for example insufficient funds): the claim is **deleted**, exactly as the customer's own `deposit` call does. A refused deposit never stays pending, because it would otherwise book later, when funds arrive, with nobody's current yes. The pass reports the position as `failed`.
- Unknown failure: the claim stays `pending` for the next pass. The post may have committed.

## 4. Card settlements and auto-invest runs

- A card capture or reversal whose ledger outcome is unknown now leaves its `bank.card_settlements` row `pending` (it used to write `rejected`). The same call again re-drives the same key. While the row is pending, the opposite kind is refused (`bank.card_settlement_kind_conflict`): a reversal must not release a hold that a capture may already have spent. Only a definite ledger refusal writes `rejected` with its code.
- An auto-invest run (`bank.auto_invest_runs`) whose deposit or convert outcome is unknown stays `pending`. Only a typed bank refusal or a definite ledger refusal writes `rejected`. A card round-up is re-driven on the same run id by the next capture. A threshold sweep or DCA row that is `pending` is reported as pending and is not re-driven by the runner.
- Known gap: the HTTP convert port (`trade-convert-port.ts`) turns every failure, including a timeout after the order was sent, into `bank.auto_invest_rate_unset`, which counts as a typed refusal. A DCA run can therefore still be marked `rejected` for an unknown convert outcome. The trade-side idempotency key (`clientConvertId`) is stable, so check svc-trade for the fill before treating such a run as failed.

```sql
-- stuck claims, oldest first (bank DB, read-only)
SELECT 'card_settlement' AS kind, id::text, status, created_at FROM bank.card_settlements WHERE status = 'pending'
UNION ALL
SELECT 'earn_position', id::text, status::text, opened_at FROM bank.earn_positions WHERE status = 'pending'
UNION ALL
SELECT 'auto_invest_run', id::text, status::text, created_at FROM bank.auto_invest_runs WHERE status = 'pending'
ORDER BY created_at;
```

## 5. Not decided here

Whether an old, unbooked request may still be booked is **not** limited by age in this change, apart from the loan draw's price check. The ADR records why expiry windows were dropped for now, what is next (a fence for price-dependent system posts, then scheduled recovery jobs with age alerts), and when to revisit.
