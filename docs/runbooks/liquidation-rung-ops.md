# Runbook — liquidation rungs (svc-trade futures)

**Code:** `services/svc-trade/src/futures/liquidation-rungs.ts`, `liquidation-tick.ts`, `tick-stores.ts` · **Table:** `trade.liquidation_rungs` (migration `0050_liquidation_rungs`).
**Money law:** the ledger is the only book. Nothing below edits `ledger.*`; a ledger movement is always a posting through the operator door named in [`../ops/INCIDENT-MONEY-PATH-RUNBOOK.md`](../ops/INCIDENT-MONEY-PATH-RUNBOOK.md). Rows in `trade.positions` are the _mirror_ and may be hand-fixed to match the ledger, never the other way round.

A **rung** is one tranche of a liquidation (a partial reduction, or the closing rung). It is stored before its first ledger post and walks `planned → posted → applied`. A rung whose loss is booked but whose position row cannot be reconciled is `abandoned`, and the position is **parked**. An operator ends the park by marking the rung `resolved`.

## 1. What raises a flag (all at error level, every tick while true)

| Log line (job `futures.liquidation`)                                        | Meaning                                                                                                                                                                                                      | Section |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `position <id> errored (trade.liquidation_row_changed_after_post): …`       | The rung just got abandoned: loss booked, row could not be reconciled. The position is now parked.                                                                                                           | 2       |
| `liquidation parked: the latest rung was abandoned … positionId=<id>`       | A parked position (reason `trade.liquidation_abandoned_parked`). Nothing is planned for it until resolved. **An unhealthy parked position is not being liquidated.**                                         | 2       |
| `liquidation rung parked: claim exists but position still open …`           | A closing rung claimed by the code from before rung ids. Same handling as a park.                                                                                                                            | 2.4     |
| `trade.liquidation_margin_drift positionId=… rungId=… amount=…`             | A closing rung closed the row but the row's margin was not what the stored release assumed. `amount` is signed.                                                                                              | 3       |
| `trade.liquidation_margin_clipped positionId=… rungId=… amount=…`           | A partial rung applied but the row held less margin than the loss took; `margin_current` was floored at 0. `amount` is the (negative) shortfall.                                                             | 3       |
| `position <id> errored (trade.liquidation_insurance_underfunded_on_replay)` | A stored rung needs insurance cover the fund no longer has. The rung stays live and retries every tick; top up the fund or follow ADL policy.                                                                | —       |
| `trade.liquidation_release_short positionId=… rungId=… amount=…`            | A closing rung's margin release was amended DOWN by `amount` because the pot held less than planned (funding or a margin withdrawal took some first). The position closed. See 3.                            | 3       |
| `trade.liquidation_loss_short positionId=… rungId=… amount=…`               | A PARTIAL rung's loss was booked for `amount` less than planned because the position's pot held less (funding or a withdrawal took margin after planning). The row was reduced by the margin actually taken. | 3       |
| `… (trade.liquidation_announce_failed)`                                     | A close committed but its bus announcement did not publish. Retried every tick (one attempt per tick). Fix the bus.                                                                                          | —       |

## 2. Release a parked position

A position is parked when its **latest** rung (by `created_at`) is `abandoned`. Do this per position; take the position out of harm's way first if it is unhealthy (it is not being liquidated meanwhile).

### 2.1 Look

```sql
-- trade DB: the rung history and the row
SELECT rung_id, kind, state, from_size, from_margin, margin_drift, plan->>'sizeClosed' AS size_closed,
       plan->>'marginTaken' AS margin_taken, created_at
  FROM trade.liquidation_rungs WHERE position_id = :'pid' ORDER BY created_at;

SELECT id, user_id, status, size, margin_current, margin_asset
  FROM trade.positions WHERE id = :'pid';
```

```sql
-- ledger DB: what the ledger holds for that position (this is the truth)
SELECT balance FROM ledger.accounts
 WHERE kind = 'collateral' AND purpose = 'position:' || :'pid'
   AND owner_type = 'user' AND owner_id = :'user_id' AND asset_id = :'asset';
```

Work out, from the ledger postings for the rung (`futures.loss:liq:<pid>:rung:<rung_id>:loss`, and for a closing rung `futures.margin.release:<pid>:rung:<rung_id>`), what the position _should_ look like: remaining size, and margin = the ledger collateral balance above.

### 2.2 Fix and release, in ONE transaction

```sql
BEGIN;
-- (a) make the mirror match the ledger. Pick the case that applies:
UPDATE trade.positions
   SET margin_current = :ledger_balance,          -- must equal the ledger.accounts balance read above
       size           = :correct_size,            -- omit if size is right
       updated_at     = now()
 WHERE id = :'pid' AND status = 'open';
-- …or, if the position should be closed:
-- UPDATE trade.positions SET status = 'liquidated', closed_at = now(), updated_at = now() WHERE id = :'pid' AND status = 'open';

-- (b) release the park. Exactly one row must come back, and it must be the abandoned one.
UPDATE trade.liquidation_rungs
   SET state = 'resolved', updated_at = now()
 WHERE rung_id = :'rung_id' AND position_id = :'pid' AND state = 'abandoned'
RETURNING rung_id, state;
-- If (a) or (b) touched 0 rows: ROLLBACK and re-read; otherwise COMMIT.
COMMIT;
```

### 2.3 Check

The next tick (default 15 s) re-evaluates the position from the row. Expect either `skipped_healthy` or a new rung. The line `liquidation parked …` for this position must have stopped. Re-run the reconciliation query (section 5) for this position: it must be clean.

### 2.4 Old-style claims

A position parked by a `liquidation_attempts` row (`liquidation_id = 'liq:<pid>'`) is released by deleting that row once the position is reconciled the same way:

```sql
DELETE FROM trade.liquidation_attempts WHERE liquidation_id = 'liq:' || :'pid';
```

## 3. Margin drift and clipped alerts (the rung applied; the books disagree by `amount`)

`margin_drift` on the rung stores the same number.

- **Closing rung, `amount` > 0:** the trader added margin while the rung posted. The loss and the stored release are booked and the row is closed, so that margin is **stranded in the position's collateral pot**. Check the ledger balance from 2.1: it should equal `amount`. Post a `futuresMarginRelease` of `amount` for the position through the operator door, key `futures.margin.release:<pid>:rung:<rung_id>:drift`. The code does not do this itself (see "why" below).
- **Closing rung, `amount` < 0:** funding took margin between the rung's post and its apply. Funding posts its own ledger legs, so there is nothing to post. Check the pot for the closed position is 0; if it is not, treat it as stranded margin as above.
- **Partial rung, clipped:** the row held less margin than the loss took, so `margin_current` was floored at 0. Compare with the ledger balance from 2.1. If the ledger still holds margin for the position, hand-set `margin_current` to it (one `UPDATE … WHERE id = :'pid' AND status = 'open'`). A positive ledger balance with a zero row means the position is under-collateralised on paper only.

_Why the code does not auto-release stranded margin:_ it is only safe if the ledger pot and the row agreed before the rung, which is exactly what is in doubt when drift appears. A failed release after the row has closed would also need its own retry state. So it is logged with the amount and left to an operator.

- **Partial rung, `trade.liquidation_loss_short`:** the pot held less than the loss's pot leg, so the loss was booked for what the pot held (`plan.lossShort` stores the missing amount). The tranche was closed on the row but the trader was charged `amount` less than the mark implied. This is on the house; decide whether it is acceptable (the next rung re-evaluates health from the row). Nothing to post.
- **Closing rung whose pot was short for the loss:** the missing part moved to the insurance leg (`plan.fromInsurance` is larger than the planned leg). Nothing to post.
- **Closing rung, `trade.liquidation_release_short`:** the release was posted for less than planned, because the pot held less (the rung's `plan.releaseShort` stores the amount, and `margin_drift` stores the row-side difference; they overlap when funding hit both). The position closed. Check the pot for the closed position: it should be 0. Nothing to post.

## 4. Deploy gate (the first deploy of rungs, and any deploy that changes how rungs plan)

Rungs that were in flight under the old claim-based code are invisible to the new code, except closing claims in `trade.liquidation_attempts`. A partial rung that posted its loss under the old key (`futures.loss:liq:<pid>:loss:partial:<closed>:<size>`) and crashed before reducing the row has **no marker**, and the new code would book that tranche again. So reconcile first:

1. Set `TRADE_FUTURES_JOBS_ENABLED=false` on svc-trade and roll it out. This stops liquidation, funding and settlement (`startFuturesJobs`). Confirm in the logs that `futures.liquidation` no longer runs.
2. Deploy the new version (migration `0050_liquidation_rungs` applies; `node tooling/ci/migration-check.mjs` is the CI gate).
3. **First run the section-5 reconciliation once on a staging snapshot** (a restore of production data) and read the mismatches before relying on it. Ordinary mismatches exist in a healthy book — for example a funding write that floored the row's margin at 0 while its ledger leg was refused — and step 4 would park every one of them, which can park the whole book. Decide per class of mismatch what the hand-fix is, then run the query for **every open position** in production. A position is clean when `margin_current` equals the ledger `position:<id>` collateral balance.
4. For each mismatching open position, park it so the new code does not plan against a half-booked tranche:
   ```sql
   INSERT INTO trade.liquidation_attempts (liquidation_id, position_id)
   VALUES ('liq:' || :'pid', :'pid'::uuid) ON CONFLICT (liquidation_id) DO NOTHING;
   ```
   Then fix each one by hand as in section 2 (the ledger is the truth) and release it with 2.4.
5. Set `TRADE_FUTURES_JOBS_ENABLED=true` again. Watch the first ticks for any line in section 1.

## 5. Recurring reconciliation (run daily, and before and after any deploy that touches positions)

The two schemas belong to two services: run each query against its own database and compare the results (for example `\copy (…) TO 'trade.csv' CSV` and the same for the ledger, then `join`/spreadsheet). **A position is clean when its row margin equals its ledger collateral balance, and a position that is not open holds no collateral.**

```sql
-- trade DB
SELECT id::text AS position_id, user_id::text, margin_asset AS asset, status, margin_current AS margin
  FROM trade.positions
 ORDER BY id;
```

```sql
-- ledger DB: one row per position pot
SELECT substring(purpose FROM 10) AS position_id, owner_id AS user_id, asset_id AS asset, balance
  FROM ledger.accounts
 WHERE kind = 'collateral' AND purpose LIKE 'position:%' AND owner_type = 'user'
 ORDER BY 1;
```

Flag: open position where `margin <> balance` (a missing ledger row counts as balance 0); any position with `status IN ('closed','liquidated')` and `balance > 0` (stranded margin).

The rung table has its own health query (trade DB). All three of these must normally return zero rows:

```sql
-- abandoned and not yet resolved: parked positions
SELECT position_id, rung_id, created_at FROM trade.liquidation_rungs
 WHERE state = 'abandoned' AND NOT EXISTS (
   SELECT 1 FROM trade.liquidation_rungs n
    WHERE n.position_id = liquidation_rungs.position_id AND n.created_at > liquidation_rungs.created_at);

-- applied rungs whose margin did not reconcile
SELECT position_id, rung_id, kind, margin_drift FROM trade.liquidation_rungs
 WHERE state = 'applied' AND margin_drift <> 0;

-- live rungs stuck for more than 10 minutes, or closes never announced
SELECT position_id, rung_id, kind, state, created_at FROM trade.liquidation_rungs
 WHERE (state IN ('planned','posted') AND updated_at < now() - interval '10 minutes')
    OR (kind = 'closing' AND state = 'applied' AND announced_at IS NULL AND updated_at < now() - interval '10 minutes');
```

## 6. A rung stuck live (`planned` or `posted`, erroring every tick)

A live rung is replayed every tick until it applies. If it keeps erroring, find which error:

- `trade.liquidation_insurance_underfunded_on_replay` — read it carefully: since this version the tick only reports it when the insurance fund really is below the leg, but an older build also reported it when the **position's own pot** was short (funding or a withdrawal shrank it after the rung was planned). **Check the pot first** (the ledger query in 2.1: `balance` for `position:<id>`) and compare it with the loss recipe's collateral leg in the rung's plan. If the pot holds less than that leg, the current version amends the loss by itself (the missing part moves to the insurance leg on a closing rung, and is recorded as `trade.liquidation_loss_short` on a partial rung); no top-up is needed. Only if the pot holds enough and the insurance balance is below `plan.fromInsurance` top the fund up (or follow the ADL policy), and the next tick finishes it.
- A refused margin release was amended automatically (since this version) when the pot holds less than planned; before that version it errored forever. If a release is still refused, the pot holds MORE than the planned amount yet the post fails, which is a ledger-side problem: read the ledger error in the log line.
- Any other persistent ledger refusal (frozen posting, account unknown, idempotency conflict).

To decide:

1. **Which of the rung's recipe keys are booked?** Ask svc-ledger directly (`ledger.ledger_tx`), for the keys in the rung's plan:
   ```sql
   -- trade DB: the keys the rung posts
   SELECT r->>'idempotencyKey' AS key, r->>'reason' AS reason
     FROM trade.liquidation_rungs, jsonb_array_elements(plan->'recipes') r WHERE rung_id = :'rung_id';
   ```
   ```sql
   -- ledger DB: which of them exist. `ANY` needs an array literal, e.g. :'keys' = '{futures.loss:liq:…:loss,futures.margin.release:…}'
   SELECT idempotency_key, posted_at FROM ledger.ledger_tx WHERE idempotency_key = ANY (:'keys'::text[]);
   ```
2. **Nothing booked** (no loss key): the rung can simply be given up — it has cost nothing. Set it `abandoned` and the position parks only until you `resolve` it; the next tick will plan afresh once resolved.
3. **The loss is booked** (the usual case for a stuck rung): the row must catch up, so fix the cause on the ledger side (unfreeze posting, restore the account) and let the next tick apply it. Abandon only if the position must be hand-closed or hand-reduced.
4. To abandon, in ONE transaction, then continue with section 2 (hand-fix the row to the ledger, then resolve):
   ```sql
   BEGIN;
   UPDATE trade.liquidation_rungs
      SET state = 'abandoned', updated_at = now()
    WHERE rung_id = :'rung_id' AND position_id = :'pid' AND state IN ('planned','posted')
   RETURNING rung_id, state;       -- exactly one row, or ROLLBACK
   COMMIT;
   ```
   The position is now parked (reason `trade.liquidation_abandoned_parked`). Do not run two tick workers' worth of hand edits: stop `TRADE_FUTURES_JOBS_ENABLED` first if several positions are in this state.
