import { postPayLedger } from './ledger-receipt.js';
import type { Sql } from 'postgres';
import { withPayoutLock, payoutTransaction } from './payout-admission.js';
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  InsufficientFundsError,
  LedgerError,
  parseAmount,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { PayError, assertWithdrawalListLimit } from './payment-service.js';
import { assertPayoutDestinationKind, DestinationKindError } from './payout-destination.js';
import type { RailRegistry } from './rails/registry.js';
import { assertRailMayMoveValue, type ValueMovementPolicy } from './rails/posture.js';
import { withMoneySpan, withRailSpan } from './tracing.js';

/**
 * USER MONEY IN AND OUT (§4.2 `deposit` / `withdraw`).
 *
 * `PayService` is about MERCHANT money — a third party pays a merchant, and we
 * clear and settle it. This is the other half: a USER's own balance entering and
 * leaving the book.
 *
 * WHY IT IS IN svc-pay. Value entering the book must come from a rail, value
 * leaving it goes out through one, and the `RailAdapter` interface, the registry
 * and the two v1 adapters are all here. The alternative was a second service
 * learning about rails, or a money path with no rail behind it — which is a
 * money path with nothing reconciliation can check it against.
 *
 * THE THREE RULES FROM `payment-service.ts` APPLY UNCHANGED.
 *
 * 1. Value moves only through a ledger recipe (Doctrine §0.6). This service
 *    holds no balance; it holds a row saying what was intended and how far it
 *    got.
 * 2. Idempotency keys are business keys. `deposit:<rail>:<railRef>` and
 *    `withdraw.*:<withdrawalId>:<attempt>`. Never a random uuid.
 * 3. The direction of the money decides the order of operations:
 *
 *      INBOUND  (deposit)  — the rail moved first, in the real world. We book
 *                            value we are told has already arrived, and the
 *                            claim is committed before the booking so a crash
 *                            leaves a resumable marker rather than an
 *                            unexplained ledger entry.
 *
 *      OUTBOUND (withdraw) — the LEDGER moves first. The user must be shown to
 *                            have the money, in a hold, before any of it is sent
 *                            somewhere irreversible.
 *
 * WHOSE FUNDS ARE STRANDED IF THIS CRASHES EXACTLY HERE — answered per branch,
 * at each branch, below. That question is the reason for every extra state in
 * these two state machines.
 */

export interface DepositRecord {
  id: string;
  userId: string;
  assetId: string;
  amount: Amount;
  rail: string;
  railRef: string;
  creditedBy: string;
  status: 'pending' | 'credited';
  createdAt: Date;
}

export interface WithdrawalRecord {
  id: string;
  userId: string;
  assetId: string;
  amount: Amount;
  rail: string;
  destination: { kind: string; ref: string };
  clientRef: string;
  railRef: string | null;
  attempts: number;
  failureCode: string | null;
  status: 'pending' | 'held' | 'sent' | 'failed';
  createdAt: Date;
}

interface DepositRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  rail: string;
  rail_ref: string;
  credited_by: string;
  status: DepositRecord['status'];
  created_at: Date;
}

interface WithdrawalRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  rail: string;
  destination: { kind: string; ref: string };
  client_ref: string;
  rail_ref: string | null;
  attempts: number;
  failure_code: string | null;
  status: WithdrawalRecord['status'];
  created_at: Date;
}

export interface UserMoneyOptions {
  /**
   * Rails an operator may credit a deposit on, by hand.
   *
   * NOT every registered rail. An operator credit asserts "this value arrived",
   * and on a real rail that assertion has a counterparty who can be asked. On a
   * sandbox rail there is no counterparty, which is exactly why a hand credit is
   * honest there and dishonest everywhere else: a hand-typed `crypto-native`
   * deposit would move `railBoundary('crypto-native')` away from the chain
   * balance it is supposed to mirror, and reconciliation would report a
   * discrepancy that is really a typo.
   */
  readonly operatorCreditRails: readonly string[];

  /**
   * Whether a SANDBOX rail may be asked to send a user's money out.
   *
   * `allow-sandbox` in dev and test — the sandbox rails are the fixture the whole
   * suite runs on. `live-only` in staging and prod, decided once at boot by
   * `assertRailPosture` so the boot refusal and this runtime check cannot come to
   * different conclusions.
   *
   * Defaulted to `allow-sandbox` because every construction in a test is a
   * development one; the enforced environments do not rely on this default, they
   * are handed the policy explicitly by `index.ts`.
   */
  readonly valueMovement?: ValueMovementPolicy;
}

export class UserMoneyService {
  private readonly creditableRails: ReadonlySet<string>;
  private readonly valueMovement: ValueMovementPolicy;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly rails: RailRegistry,
    options: UserMoneyOptions,
  ) {
    this.creditableRails = new Set(options.operatorCreditRails);
    this.valueMovement = options.valueMovement ?? 'allow-sandbox';
  }

  // ── Deposit ────────────────────────────────────────────────────────────────

  /**
   * Credit a user's `available` balance from a rail. THE INBOUND MONEY PATH.
   *
   * OPERATOR-CREDENTIALED. `creditedBy` is the operator, never the beneficiary,
   * and the router gates it on `admin:treasury` — a user who can call the thing
   * that credits their own balance does not need to deposit at all.
   *
   * Two phases, and the split is not ceremony:
   *
   *   1. CLAIM. The `(rail, railRef)` row is inserted and committed. Nothing has
   *      been booked.
   *   2. BOOK. `recipes.deposit` posts, then the row flips to `credited`.
   *
   * IF THIS CRASHES BETWEEN THEM, whose funds are stranded? The user's, briefly
   * — the value is at the rail and not yet in the book, and the `pending` row is
   * the marker that says so. `deposits_status_idx` exists so an operator can
   * list exactly those. Re-running with the same `(rail, railRef)` finds this
   * row, re-posts (the ledger key is identical, so it is a no-op if it already
   * landed) and finishes the job.
   *
   * IF IT CRASHES AFTER THE POST AND BEFORE THE UPDATE, nothing is stranded at
   * all: the user has their money and the row is one status behind. That is a
   * reporting lag, not a money problem, and it is the deliberately cheaper of
   * the two failure modes — which is why the claim goes first.
   */
  async credit(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    rail: string;
    railRef: string;
    creditedBy: string;
  }): Promise<DepositRecord> {
    if (input.amount <= 0n) throw new PayError('Deposit amount must be positive', 'pay.invalid_amount');

    // The rail must be one the platform actually has, so `railBoundary(rail)` is
    // a boundary account reconciliation already knows about. The adapter is NOT
    // called: the value arrived without us asking, and there is no capability on
    // the §6.1 interface that means "confirm an inbound transfer I already have".
    if (!this.rails.has(input.rail)) {
      throw new PayError(`No rail adapter "${input.rail}" — registered: ${this.rails.ids().join(', ')}`, 'pay.rail_unknown');
    }
    if (!this.creditableRails.has(input.rail)) {
      throw new PayError(
        `Rail "${input.rail}" does not accept operator credits — a real rail's deposits arrive through its own confirmation path`,
        'pay.rail_not_creditable',
        { rail: input.rail, creditable: [...this.creditableRails] },
      );
    }

    return withMoneySpan(
      'pay.deposit',
      { operation: 'deposit', rail: input.rail, railRef: input.railRef, amount: formatAmount(input.amount) },
      async (span) => {
        const claimed = await this.claimDeposit(input);

        if (claimed.status === 'credited') return claimed;

        // Keyed `deposit:<rail>:<railRef>` — the same key the unique index above
        // enforces, so svc-pay and the ledger cannot disagree about what
        // "already credited" means.
        await postPayLedger(
          this.ledger,
          recipes.deposit({
            userId: claimed.userId,
            assetId: claimed.assetId,
            amount: claimed.amount,
            rail: claimed.rail,
            railRef: claimed.railRef,
          }),
        );

        await this.sql`
          UPDATE pay.deposits SET status = 'credited', updated_at = now()
           WHERE id = ${claimed.id} AND status = 'pending'
        `;

        span.setAttribute('intafaced.amount', formatAmount(claimed.amount));
        return { ...claimed, status: 'credited' as const };
      },
    );
  }

  /**
   * Claim `(rail, railRef)`, or return the existing claim.
   *
   * A REPEAT THAT SAYS SOMETHING DIFFERENT IS REFUSED, and this is the branch
   * that matters most on the whole path. `recipes.deposit` is keyed on
   * `(rail, railRef)` alone, so a second call for the same reference with a
   * larger amount would post, find the ORIGINAL transaction by idempotency key,
   * return it unchanged — and we would answer "credited 500" about a book that
   * moved 5. The mismatch has to be an error here, before the ledger is asked,
   * because the ledger's answer is indistinguishable from success.
   */
  private async claimDeposit(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    rail: string;
    railRef: string;
    creditedBy: string;
  }): Promise<DepositRecord> {
    return transaction(
      this.sql,
      async (tx) => {
        const inserted = await tx<DepositRow[]>`
          INSERT INTO pay.deposits (user_id, asset_id, amount, rail, rail_ref, credited_by, status)
          VALUES (
            ${input.userId}, ${input.assetId}, ${formatAmount(input.amount)}::numeric,
            ${input.rail}, ${input.railRef}, ${input.creditedBy}, 'pending'
          )
          ON CONFLICT ("rail", "rail_ref") DO NOTHING
          RETURNING id, user_id, asset_id, amount, rail, rail_ref, credited_by, status, created_at
        `;
        if (inserted[0]) return toDeposit(inserted[0]);

        const rows = await tx<DepositRow[]>`
          SELECT id, user_id, asset_id, amount, rail, rail_ref, credited_by, status, created_at
            FROM pay.deposits WHERE rail = ${input.rail} AND rail_ref = ${input.railRef} FOR UPDATE
        `;
        const existing = toDeposit(rows[0]!);

        const mismatch = existing.userId !== input.userId || existing.assetId !== input.assetId || existing.amount !== input.amount;
        if (mismatch) {
          throw new PayError(
            `Rail reference ${input.rail}:${input.railRef} was already credited as ` +
              `${formatAmount(existing.amount)} ${existing.assetId} to ${existing.userId}`,
            'pay.deposit_conflict',
            {
              existing: { userId: existing.userId, assetId: existing.assetId, amount: formatAmount(existing.amount) },
              requested: { userId: input.userId, assetId: input.assetId, amount: formatAmount(input.amount) },
            },
          );
        }

        return existing;
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  // ── Withdrawal ─────────────────────────────────────────────────────────────

  /**
   * A user moves their own balance off the platform. THE OUTBOUND MONEY PATH.
   *
   * hold → rail → settle, or hold → rail refuses → reverse. The sequence is the
   * one `payoutSettlement` already uses for a merchant, and it is the same
   * because the shape is the same: there is no moment at which the user's money
   * is neither in their available balance, nor in a hold that names this
   * withdrawal, nor gone with a rail reference against it.
   *
   * P0-3: the hold is PURPOSE-KEYED — `withdraw:<withdrawalId>:<attempt>`, via
   * `withdrawalHoldAccount`. With one shared hold per (user, asset) a settle
   * could consume value an open order had reserved, and the books would balance
   * while the order went unfunded.
   *
   * RESUMABLE ON `clientRef`. A client that retries a timed-out request must
   * resume this withdrawal, not open a second one — a second one is a second
   * debit. That is why `clientRef` is required rather than recommended.
   */
  async withdraw(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    rail: string;
    destination: { kind: string; ref: string };
    clientRef: string;
  }): Promise<WithdrawalRecord> {
    if (input.amount <= 0n) throw new PayError('Withdrawal amount must be positive', 'pay.invalid_amount');

    // Resolved before a row exists, so an unknown or payout-incapable rail fails
    // before anything is claimed — and long before anything is held.
    const adapter = this.rails.require(input.rail, 'payout');

    // AND BEFORE ANYTHING IS HELD: a sandbox rail cannot send a user's money
    // anywhere, so in an enforced posture asking it is refused here rather than
    // discovered as a fabricated `railRef` in `withdrawals.rail_ref` after the
    // user has been told `sent`. Refusing at this line means no row exists, no
    // hold was placed, and nothing has to be unwound.
    assertRailMayMoveValue(adapter, 'payout', this.valueMovement);

    // Same gate as merchant payoutSettlement: crypto must not accept an IBAN
    // (and bank/sandbox must not accept a chain address). BEFORE claim/hold so
    // a mismatch never leaves a withdrawal row or stranded funds.
    try {
      assertPayoutDestinationKind(adapter.id, input.destination);
    } catch (err) {
      if (err instanceof DestinationKindError) {
        throw new PayError(err.message, err.code);
      }
      throw err;
    }

    return withMoneySpan('pay.withdraw', { operation: 'withdraw', rail: input.rail, amount: formatAmount(input.amount) }, async (span) =>
      withPayoutLock(this.sql, `withdraw:${JSON.stringify([input.userId, input.clientRef])}`, async (connection) => {
        let claimed = await this.claimWithdrawal(input, connection);

        // Already finished. Returning it is the only correct answer to a retry:
        // the money is gone and asking the rail again would send it twice.
        if (claimed.status === 'sent') return claimed;

        // A durable first-dispatch refusal proves no rail effect even if the
        // process died before recording its failure code. Finish the original
        // reverse — never re-ask the rail. Caller may open a *new* clientRef (or the same
        // clientRef after status is `failed` and attempts advanced) for another try.
        if (claimed.status === 'held') {
          const [refusal] = await connection`
          SELECT outcome FROM pay.withdrawal_rail_attempts
           WHERE withdrawal_id = ${claimed.id} AND attempt = ${claimed.attempts}
        `;
          if (refusal?.outcome === 'refused') {
            const code = claimed.failureCode ?? 'rail.failed';
            await this.finalizeRailRefusal(claimed, code, connection);
            throw new PayError('Rail refused the withdrawal', 'pay.rail_failed', {
              withdrawalId: claimed.id,
              failureCode: code,
            });
          }
          if (claimed.failureCode)
            throw new PayError('Original rail refusal is unproven; withdrawal remains held', 'pay.rail_outcome_unknown');
        }

        // Residual #8: a terminal `failed` row is "this attempt is done", not
        // "this clientRef is dead forever". `attempts` advanced on finalize; the
        // next call with the same clientRef (same money + destination) opens the
        // next attempt key `withdraw:<id>:<attempts>` so it cannot reuse a
        // released hold. Different money/destination still conflicts above.
        if (claimed.status === 'failed') {
          await connection`
            UPDATE pay.withdrawals
               SET status = 'pending', failure_code = NULL, updated_at = now()
             WHERE id = ${claimed.id} AND status = 'failed'
          `;
          claimed = { ...claimed, status: 'pending', failureCode: null };
        }

        const attempt = claimed.attempts;
        const ledgerInput = {
          userId: claimed.userId,
          assetId: claimed.assetId,
          amount: claimed.amount,
          rail: claimed.rail,
          withdrawalId: `${claimed.id}:${attempt}`,
        };

        // ── Phase 1: the ledger. Funds leave `available` for a hold that names
        // this withdrawal and this attempt.
        //
        // A ledger throw can follow a remote commit. Preserve the original
        // pending claim and key; a retry posts only those same immutable terms.
        // A held row already has an acknowledged hold and does not post again.
        if (claimed.status !== 'held') {
          // A missing ACK never proves that a remote post did not commit. Keep
          // the original pending claim and business key on every ledger throw.
          try {
            await postPayLedger(this.ledger, recipes.withdrawHold(ledgerInput));
          } catch (error) {
            throw new PayError(
              `Withdrawal ledger outcome is unknown; original claim remains pending: ${error instanceof Error ? error.message : 'ledger error'}`,
              'pay.ledger_outcome_unknown',
              { withdrawalId: claimed.id },
            );
          }
          await connection`
          UPDATE pay.withdrawals SET status = 'held', failure_code = NULL, updated_at = now()
           WHERE id = ${claimed.id} AND status = 'pending'
        `;
        }

        // ── Phase 2: the rail.
        //
        // IF THIS CRASHES BETWEEN THE HOLD AND THE RAIL CALL, the user's funds
        // are in `withdraw:<id>:<attempt>` — out of `available`, not yet sent.
        // The dispatch journal commits before the call. A repeat reuses the
        // same provider key; a saved acceptance skips that call entirely.
        // An unknown earlier dispatch cannot be reversed on a later refusal.
        const prior = await connection<Array<{ outcome: string; rail_ref: string | null }>>`
        SELECT outcome, rail_ref FROM pay.withdrawal_rail_attempts
         WHERE withdrawal_id = ${claimed.id} AND attempt = ${attempt}
      `;
        // Legacy held rows have unknown dispatch history. Never interpret their
        // next refusal as proof that no earlier send committed.
        const firstDispatch = prior.length === 0 && claimed.status !== 'held';
        await connection`
        INSERT INTO pay.withdrawal_rail_attempts(withdrawal_id, attempt, outcome)
        VALUES (${claimed.id}, ${attempt}, 'requested') ON CONFLICT DO NOTHING
      `;
        const accepted = prior[0]?.outcome === 'accepted' && prior[0].rail_ref;
        const result = accepted
          ? { ok: true, railRef: accepted }
          : await withRailSpan(adapter.id, 'payout', async () =>
              adapter.payout({
                settlementId: ledgerInput.withdrawalId,
                merchantId: claimed.userId,
                amount: claimed.amount,
                assetId: claimed.assetId,
                window: 'user-withdrawal',
                destination: claimed.destination,
              }),
            );
        if (!accepted && (!('amount' in result) || result.amount !== claimed.amount || result.assetId !== claimed.assetId))
          throw new PayError('Rail result does not identify the original withdrawal', 'pay.rail_outcome_unknown');
        if (result.ok && !accepted) {
          if (!('amount' in result) || result.amount !== claimed.amount || result.assetId !== claimed.assetId || !result.railRef.trim())
            throw new PayError('Rail payout receipt differs from the original withdrawal', 'pay.rail_amount_mismatch');
          await connection`
          UPDATE pay.withdrawal_rail_attempts SET outcome = 'accepted', rail_ref = ${result.railRef}
           WHERE withdrawal_id = ${claimed.id} AND attempt = ${attempt} AND outcome = 'requested'
        `;
        }

        // ── Phase 3a: the rail refused. Put the money back, durably.
        //
        // L3-1: stamp failure_code WHILE still `held` before reverse, so a crash
        // between reverse and the final status update is recoverable: retry
        // re-enters finalizeRailRefusal (idempotent reverse) and marks failed.
        // `attempts` advances only on finalization.
        if (!result.ok) {
          if (!firstDispatch)
            throw new PayError('Earlier rail result is unknown; original withdrawal remains held', 'pay.rail_outcome_unknown');
          const code = 'failureCode' in result ? (result.failureCode ?? 'rail.failed') : 'rail.failed';
          await connection`
          UPDATE pay.withdrawal_rail_attempts SET outcome = 'refused'
           WHERE withdrawal_id = ${claimed.id} AND attempt = ${attempt} AND outcome = 'requested'
        `;
          await connection`
            UPDATE pay.withdrawals
               SET failure_code = ${code}, updated_at = now()
             WHERE id = ${claimed.id} AND status = 'held'
          `;
          await this.finalizeRailRefusal({ ...claimed, failureCode: code }, code, connection);
          throw new PayError(
            ('failureReason' in result ? result.failureReason : undefined) ?? 'Rail refused the withdrawal',
            'pay.rail_failed',
            {
              failureCode: code,
              withdrawalId: claimed.id,
            },
          );
        }

        // ── Phase 3b: the rail sent it. Value leaves the book.
        //
        // IF THIS CRASHES BETWEEN THE RAIL AND THE SETTLE, the funds are still
        // in the hold and the rail has already sent them — the platform is short
        // by this amount until the settle runs. Nobody's money is lost: the
        // settle is keyed on the same attempt, so repeating the call posts it
        // once and squares the book. The rail is not asked again, because its
        // own idempotency key is the same string.
        try {
          await postPayLedger(this.ledger, recipes.withdrawSettle(ledgerInput));
        } catch (error) {
          throw new PayError(
            `Withdrawal ledger outcome is unknown; accepted rail receipt remains held: ${error instanceof Error ? error.message : 'ledger error'}`,
            'pay.ledger_outcome_unknown',
            { withdrawalId: claimed.id },
          );
        }

        await connection`
          UPDATE pay.withdrawals
             SET status = 'sent', rail_ref = ${result.railRef}, failure_code = NULL, updated_at = now()
           WHERE id = ${claimed.id}
        `;

        span.setAttribute('intafaced.amount', formatAmount(claimed.amount));
        return { ...claimed, status: 'sent' as const, railRef: result.railRef };
      }),
    );
  }

  /**
   * Claim `(userId, clientRef)`, or return the existing claim.
   *
   * Same reasoning as `claimDeposit`, and the same refusal: a retry that names
   * the same client reference with a different amount, asset or destination is a
   * client bug, and resuming it against the ORIGINAL numbers would send money
   * somewhere the caller did not just ask for.
   *
   * The `FOR UPDATE` below ends when this transaction commits. Later settle
   * and refusal steps lock the row again; they do not inherit this one.
   */
  private async claimWithdrawal(
    input: {
      userId: string;
      assetId: string;
      amount: Amount;
      rail: string;
      destination: { kind: string; ref: string };
      clientRef: string;
    },
    connection: Sql,
  ): Promise<WithdrawalRecord> {
    return payoutTransaction(connection, async (tx) => {
      const inserted = await tx<WithdrawalRow[]>`
          INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
          VALUES (
            ${input.userId}, ${input.assetId}, ${formatAmount(input.amount)}::numeric, ${input.rail},
            ${tx.json(input.destination as never)}, ${input.clientRef}, 'pending'
          )
          ON CONFLICT ("user_id", "client_ref") DO NOTHING
          RETURNING id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
        `;
      if (inserted[0]) return toWithdrawal(inserted[0]);

      const rows = await tx<WithdrawalRow[]>`
          SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
            FROM pay.withdrawals WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef} FOR UPDATE
        `;
      const existing = toWithdrawal(rows[0]!);

      const mismatch =
        existing.assetId !== input.assetId ||
        existing.amount !== input.amount ||
        existing.rail !== input.rail ||
        existing.destination.kind !== input.destination.kind ||
        existing.destination.ref !== input.destination.ref;
      if (mismatch) {
        throw new PayError(
          `Client reference "${input.clientRef}" already names a withdrawal of ` +
            `${formatAmount(existing.amount)} ${existing.assetId} to ${existing.destination.kind}`,
          'pay.withdrawal_conflict',
          { withdrawalId: existing.id },
        );
      }

      return existing;
    });
  }

  /**
   * Rail refusal, or the sent row if the overlapping call already settled.
   *
   * A `sent` return is the book. Anything else throws: a reversed withdrawal
   * is not reported as sent.
   */
  private async refuseOrReturnSent(claimed: WithdrawalRecord, failureCode: string, failureReason: string): Promise<WithdrawalRecord> {
    const finished = await this.finalizeRailRefusal(claimed, failureCode);
    if (finished.status === 'sent') return finished;
    throw new PayError(failureReason, 'pay.rail_failed', {
      failureCode,
      withdrawalId: claimed.id,
    });
  }

  /**
   * Post `withdrawSettle` only while this attempt is still allowed to settle.
   *
   * Allowed means `held` and `failure_code` is null: the hold is in place and
   * nobody has claimed the reverse. `sent` is already done — return it, do not
   * post again. `failed`, or `held` with a refusal stamp, stays that way.
   *
   * The lock is held across the post and the status update. `withdrawSettle`
   * and `withdrawReverse` do not share an idempotency key, so posting first
   * and noticing a lost update afterwards would leave both recipes on the book.
   */
  private async settleHeldWithdrawal(withdrawalId: string, railRef: string): Promise<WithdrawalRecord> {
    return transaction(
      this.sql,
      async (tx) => {
        const row = await this.lockWithdrawal(tx, withdrawalId);
        if (row.status === 'sent') return row;
        if (row.status === 'failed' || row.failureCode) {
          throw new PayError('Rail refused the withdrawal', 'pay.rail_failed', {
            failureCode: row.failureCode,
            withdrawalId: row.id,
          });
        }
        if (row.status !== 'held') {
          throw new PayError(`Withdrawal ${row.id} cannot settle from ${row.status}`, 'pay.invalid_transition', {
            withdrawalId: row.id,
          });
        }

        await this.ledger.post(recipes.withdrawSettle(this.attemptLedgerInput(row)));

        const updated = await tx<WithdrawalRow[]>`
          UPDATE pay.withdrawals
             SET status = 'sent', rail_ref = ${railRef}, failure_code = NULL, updated_at = now()
           WHERE id = ${row.id} AND status = 'held' AND failure_code IS NULL
          RETURNING id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
        `;
        if (!updated[0]) {
          throw new PayError(`Withdrawal ${row.id} settle matched 0 rows`, 'pay.invalid_transition', {
            withdrawalId: row.id,
          });
        }
        return toWithdrawal(updated[0]);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /** The claim lock is over. Re-read this row and hold it until the caller commits. */
  private async lockWithdrawal(tx: Sql, withdrawalId: string): Promise<WithdrawalRecord> {
    const rows = await tx<WithdrawalRow[]>`
      SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
        FROM pay.withdrawals
       WHERE id = ${withdrawalId}
         FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Withdrawal ${withdrawalId} not found`, 'pay.withdrawal_not_found');
    return toWithdrawal(row);
  }

  /**
   * Complete a rail-refusal reverse. Idempotent on the attempt key.
   *
   * Preconditions: row is `held` with a durable first-dispatch refusal receipt.
   * A missing recorded provider code remains the generic rail failure.
   * Steps: reverse hold → status `failed` + attempts++. Either step may be
   * re-run after a crash; reverse is ledger-idempotent and the final UPDATE
   * is guarded on `status = 'held'`.
   */
  private async finalizeRailRefusal(claimed: WithdrawalRecord, failureCode: string, connection: Sql): Promise<void> {
    const attempt = claimed.attempts;
    const ledgerInput = {
      userId: claimed.userId,
      assetId: claimed.assetId,
      amount: claimed.amount,
      rail: claimed.rail,
      withdrawalId: `${claimed.id}:${attempt}`,
    };
    await postPayLedger(this.ledger, recipes.withdrawReverse(ledgerInput));
    await connection`
        UPDATE pay.withdrawals
           SET status = 'failed', attempts = attempts + 1,
               failure_code = ${failureCode}, updated_at = now()
         WHERE id = ${claimed.id} AND status = 'held'
      `;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getWithdrawal(withdrawalId: string): Promise<WithdrawalRecord> {
    const rows = await this.sql<WithdrawalRow[]>`
      SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
        FROM pay.withdrawals WHERE id = ${withdrawalId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Withdrawal ${withdrawalId} not found`, 'pay.withdrawal_not_found');
    return toWithdrawal(row);
  }

  async listWithdrawals(userId: string, limit?: number): Promise<WithdrawalRecord[]> {
    const page = assertWithdrawalListLimit(limit);
    const rows = await this.sql<WithdrawalRow[]>`
      SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
        FROM pay.withdrawals WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${page}
    `;
    return rows.map(toWithdrawal);
  }

  /**
   * What the user can actually withdraw, read from the LEDGER.
   *
   * Not from these tables, and not derived by summing deposits minus
   * withdrawals. Doctrine §0.6: the ledger is the balance, and asking it keeps
   * svc-pay's records and the book independent — which is the whole property a
   * reconciliation job needs in order to mean anything.
   */
  async availableBalance(userId: string, assetId: string): Promise<Amount> {
    return (await this.ledger.balance(userAvailable(userId, assetId))).amount;
  }

  /** What is currently immobilised for one in-flight withdrawal. An operator question, answered from the book. */
  async heldBalance(withdrawal: WithdrawalRecord): Promise<Amount> {
    const account = withdrawalHoldAccount(withdrawal.userId, withdrawal.assetId, `${withdrawal.id}:${withdrawal.attempts}`);
    return (await this.ledger.balance(account)).amount;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toDeposit(row: DepositRow): DepositRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    amount: parseAmount(row.amount),
    rail: row.rail,
    railRef: row.rail_ref,
    creditedBy: row.credited_by,
    status: row.status,
    createdAt: row.created_at,
  };
}

function isInsufficientFunds(err: unknown): boolean {
  return err instanceof InsufficientFundsError || (err instanceof LedgerError && err.code === 'ledger.insufficient_funds');
}

function toWithdrawal(row: WithdrawalRow): WithdrawalRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    amount: parseAmount(row.amount),
    rail: row.rail,
    destination: row.destination,
    clientRef: row.client_ref,
    railRef: row.rail_ref,
    attempts: Number(row.attempts),
    failureCode: row.failure_code,
    status: row.status,
    createdAt: row.created_at,
  };
}
