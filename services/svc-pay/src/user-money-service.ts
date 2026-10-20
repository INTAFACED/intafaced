import { postPayLedger } from './ledger-receipt.js';
import type { Sql } from 'postgres';
import { withPayoutLock, payoutTransaction } from './payout-admission.js';
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  parseAmount,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { PayError, assertWithdrawalListLimit } from './payment-service.js';
import { liveAccountsIn } from './sandbox-ledger-guard.js';
import { FRESH, NOOP_GUARDS, PayGuardRefusal, settleGuardRefusal, type GuardReplay, type PayGuards } from './seams/guards.js';
import { GUARD_WITHDRAWAL_LIMITS_UNWIRED, type WithdrawalAllowanceView, type WithdrawalLimitReader } from './limits/reader.js';
import { assertStoredTransition } from './withdrawals/status.js';
import type { WithdrawalEligibility, EligibilityView } from './withdrawals/eligibility.js';
import type { PurchaseHoldGuard } from './withdrawals/purchase-holds/service.js';
import type { WithdrawalHistory, WithdrawalHistoryFilter, WithdrawalHistoryPage } from './withdrawals/history.js';
import { noteAutoTripAccountError } from './halts/autotrip-log.js';
import { isRailHealthFailureCode } from './halts/rail-health.js';
import { payoutRailSourceKey, userHaltKey, type PayHaltStore } from './halts/store.js';
import { assertPayoutDestinationKind, DestinationKindError } from './payout-destination.js';
import {
  railBlockingReason,
  railReasonCode,
  railRefusalIfBlocking,
  type PayoutRailStatus,
  type RailAdapter,
  type RailResult,
  type SettlementInstruction,
} from './rails/rail-adapter.js';
import type { RailRegistry } from './rails/registry.js';
import { assertRailMayMoveValue, type ValueMovementPolicy } from './rails/posture.js';
import { withMoneySpan, withRailSpan } from './tracing.js';
import { railRetryWhileRequested, supportLabel, type ChainReader, type WalletAttempt, type WalletPay } from './wallet/wallet-pay.js';

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

  /**
   * Guard seams (seams/guards.ts); only `beforeUserMoneyWithdrawal` is called
   * here. Omitted = no-ops, i.e. behaviour before the seams.
   */
  readonly guards?: PayGuards;

  /**
   * Auto-trip streak writer. A confirmed withdrawal rail acceptance or refusal
   * is recorded against every merchant this user owns, on that rail. Omitted,
   * or constructed with no failure count, records nothing.
   */
  readonly haltStore?: PayHaltStore;

  /**
   * Customer wallet rules (slice S38). Omitted in tests that exercise the rail
   * state machine on its own. When set, a fresh withdrawal is refused here,
   * before a hold, while the published withdraw feature is not live.
   */
  readonly wallet?: WalletPay;

  /** Used when a support read falls through to `pay.withdrawal_rail_attempts`. Down leaves the label unknown. */
  readonly chainReader?: ChainReader;

  /** Reads a customer's remaining withdrawal allowance (D-148). Omitted: the read refuses, it never guesses a figure. */
  readonly withdrawalLimits?: WithdrawalLimitReader;

  /** The customer's withdrawal history (W-withdraw-06). Omitted: the read refuses. */
  readonly withdrawalHistory?: WithdrawalHistory;

  /** The pre-submit eligibility read (W-withdraw-06). Omitted: the read refuses. */
  readonly withdrawalEligibility?: WithdrawalEligibility;

  /**
   * Funds from a card, ACH or PayPal purchase that may be traded but not withdrawn until released (W-withdraw-13).
   * Omitted: no purchase is held back, which is the state before any hold is recorded.
   */
  readonly purchaseHolds?: PurchaseHoldGuard;
}

/**
 * Sum of a user's open withdrawal holds for an asset, from the one real
 * withdrawal table. This is the figure the wallet cap check counts.
 */
export function openWithdrawalHolds(sql: Sql): (userId: string, assetId: string) => Promise<Amount> {
  return async (userId, assetId) => {
    const rows = await sql<Array<{ total: string }>>`
      SELECT coalesce(sum(amount), 0)::text AS total FROM pay.withdrawals
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND status IN ('pending', 'held')
    `;
    return parseAmount(rows[0]?.total ?? '0');
  };
}

export class UserMoneyService {
  private readonly creditableRails: ReadonlySet<string>;
  private readonly valueMovement: ValueMovementPolicy;
  private readonly guards: PayGuards;
  private readonly haltStore: PayHaltStore | undefined;
  private readonly wallet: WalletPay | undefined;
  private readonly chainReader: ChainReader;
  private readonly withdrawalLimits: WithdrawalLimitReader | undefined;
  private readonly withdrawalHistory: WithdrawalHistory | undefined;
  private readonly withdrawalEligibility: WithdrawalEligibility | undefined;
  private readonly purchaseHolds: PurchaseHoldGuard | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly rails: RailRegistry,
    options: UserMoneyOptions,
  ) {
    this.creditableRails = new Set(options.operatorCreditRails);
    this.valueMovement = options.valueMovement ?? 'allow-sandbox';
    this.guards = options.guards ?? NOOP_GUARDS;
    this.haltStore = options.haltStore;
    this.wallet = options.wallet;
    this.chainReader = options.chainReader ?? { confirm: async () => 'down' };
    this.withdrawalLimits = options.withdrawalLimits;
    this.withdrawalHistory = options.withdrawalHistory;
    this.withdrawalEligibility = options.withdrawalEligibility;
    this.purchaseHolds = options.purchaseHolds;
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
    /** A sandbox API key cannot credit a live balance. */
    keyEnv?: 'sandbox';
  }): Promise<DepositRecord> {
    if (input.amount <= 0n) throw new PayError('Deposit amount must be positive', 'pay.invalid_amount');
    if (input.keyEnv === 'sandbox') {
      refuseSandboxLive(
        recipes.deposit({
          userId: input.userId,
          assetId: input.assetId,
          amount: input.amount,
          rail: input.rail,
          railRef: input.railRef,
        }),
      );
    }

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
   * Refuse a fresh rail ask. This service has no injected clock, so the age is
   * the wall clock (`railBlockingReason`'s default). Callers skip this for a
   * `sent` replay, a held refusal's reverse, and a saved acceptance's settle.
   */
  private refuseFreshWithdrawal(adapter: RailAdapter): void {
    const blocked = railBlockingReason(adapter);
    if (!blocked) return;
    throw new PayError(`Rail "${adapter.id}" is not usable (${blocked}). No value moved.`, 'pay.rail_failed', {
      failureCode: railReasonCode(blocked),
    });
  }

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
    /** A sandbox API key cannot debit a live balance. */
    keyEnv?: 'sandbox';
  }): Promise<WithdrawalRecord> {
    if (input.amount <= 0n) throw new PayError('Withdrawal amount must be positive', 'pay.invalid_amount');
    if (this.wallet) {
      const prior = await this.sql<Array<{ status: string }>>`
        SELECT status FROM pay.withdrawals
         WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}
      `;
      const status = prior[0]?.status;
      // A fresh ask is the customer door. A held or sent retry finishes the
      // original withdrawal and must not be refused by a later feature gate.
      if (!status || status === 'failed') {
        await this.wallet.assertCustomerWithdrawal({
          userId: input.userId,
          assetId: input.assetId,
          network: input.rail,
          amount: input.amount,
          clientRef: input.clientRef,
          typedAddress: input.destination.ref,
        });
      }
    }
    if (input.keyEnv === 'sandbox') {
      refuseSandboxLive(
        recipes.withdrawHold({
          userId: input.userId,
          assetId: input.assetId,
          amount: input.amount,
          rail: input.rail,
          withdrawalId: input.clientRef,
        }),
      );
    }

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

    return withMoneySpan('pay.withdraw', { operation: 'withdraw', rail: input.rail, amount: formatAmount(input.amount) }, async (span) => {
      try {
        return await withPayoutLock(this.sql, `withdraw:${JSON.stringify([input.userId, input.clientRef])}`, async (connection) => {
          // A fresh ask (no row) and a finished refusal (`failed`) are refused
          // before the claim, so a blocked rail inserts nothing and does not
          // reopen a failed row. An existing `pending` row is still refused
          // after the claim, below. `sent` and `held` skip this check.
          const [priorClaim] = await connection<Array<{ status: string }>>`
            SELECT status FROM pay.withdrawals
             WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}
          `;
          if (!priorClaim || priorClaim.status === 'failed') {
            this.refuseFreshWithdrawal(adapter);
            await this.assertNotHeldFromPurchase(input);
          }

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
              // The reverse is durable. Count the refusal that the crashed attempt
              // never got to record. A repeat of this recovery does not count twice.
              await this.noteUserWithdrawal(connection, claimed, 'refused', code, `withdraw:${claimed.id}:${claimed.attempts}`);
              throw new PayError('Rail refused the withdrawal', 'pay.rail_failed', {
                withdrawalId: claimed.id,
                failureCode: code,
              });
            }
            if (claimed.failureCode)
              throw new PayError('Original rail refusal is unproven; withdrawal remains held', 'pay.rail_outcome_unknown');
          }

          // A blocked rail refuses a fresh dispatch only. `sent` already returned.
          // A held refusal already reversed above. A non-held claim has not posted
          // its hold yet, so refusing here leaves available untouched.
          if (claimed.status !== 'held') this.refuseFreshWithdrawal(adapter);

          // Residual #8: a terminal `failed` row is "this attempt is done", not
          // "this clientRef is dead forever". `claimWithdrawal` has already reopened
          // it as `pending` (inside the claim transaction, after the guards ran and
          // while the treasury lock was held), so `claimed.attempts` is the next
          // attempt key `withdraw:<id>:<attempts>` and cannot reuse a released
          // hold. Different money/destination still conflicts there.

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
            // The move is checked BEFORE the hold is posted: an illegal one throws and posts nothing (ENGINE W-2).
            assertStoredTransition(claimed.status, 'held');
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
          // The dispatch journal (`requested`) commits before the call. A repeat
          // never calls `payout` again for that attempt: it asks the rail for the
          // status of the original provider key and settles, reverses, or leaves
          // the hold. A saved acceptance skips the rail entirely. An unknown
          // earlier dispatch is never reversed without the rail saying `not_sent`.
          const prior = await connection<Array<{ outcome: string; rail_ref: string | null }>>`
        SELECT outcome, rail_ref FROM pay.withdrawal_rail_attempts
         WHERE withdrawal_id = ${claimed.id} AND attempt = ${attempt}
      `;
          const instruction = {
            settlementId: ledgerInput.withdrawalId,
            merchantId: claimed.userId,
            amount: claimed.amount,
            assetId: claimed.assetId,
            window: 'user-withdrawal',
            destination: claimed.destination,
          };
          // WAL-0163: a requested attempt may already have been sent, so
          // `payout` is never called again for it. The rail is asked for the
          // status of the ORIGINAL provider key instead (same pattern as the
          // merchant payout). `sent` settles below, `not_sent` reverses here,
          // anything else leaves the hold and answers outcome-unknown.
          let queriedRef: string | null = null;
          if (railRetryWhileRequested(prior[0]?.outcome) === 'unknown') {
            const queried = await this.queryRequestedWithdrawal(adapter, instruction, claimed.id);
            if (queried.status === 'not_sent') {
              const code = 'rail.not_sent';
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
              await this.noteUserWithdrawal(connection, claimed, 'refused', code, `withdraw:${claimed.id}:${attempt}`);
              throw new PayError('Rail status query confirmed the withdrawal was not sent', 'pay.rail_failed', {
                failureCode: code,
                withdrawalId: claimed.id,
              });
            }
            await connection`
          UPDATE pay.withdrawal_rail_attempts SET outcome = 'accepted', rail_ref = ${queried.railRef}
           WHERE withdrawal_id = ${claimed.id} AND attempt = ${attempt} AND outcome = 'requested'
        `;
            queriedRef = queried.railRef;
          }
          // Legacy held rows have unknown dispatch history. Never interpret their
          // next refusal as proof that no earlier send committed.
          const firstDispatch = prior.length === 0 && claimed.status !== 'held';
          const accepted = queriedRef ?? (prior[0]?.outcome === 'accepted' && prior[0].rail_ref);
          // A saved or queried acceptance settles below and does not ask the
          // rail to pay. Every other attempt records `requested` first, then
          // either a health refusal (the adapter is not called) or the payout.
          // Phase 3a reverses a first dispatch and answers outcome-unknown when
          // an earlier send may have committed.
          await connection`
        INSERT INTO pay.withdrawal_rail_attempts(withdrawal_id, attempt, outcome)
        VALUES (${claimed.id}, ${attempt}, 'requested') ON CONFLICT DO NOTHING
      `;
          let result: RailResult | { ok: true; railRef: string };
          try {
            result = accepted
              ? { ok: true, railRef: accepted }
              : (railRefusalIfBlocking(adapter, { amount: claimed.amount, assetId: claimed.assetId }) ??
                (await withRailSpan(adapter.id, 'payout', async () => adapter.payout(instruction))));
          } catch (error) {
            // Unknown rail outcome: the hold stays. Counting may halt the next
            // withdrawal. It does not reverse this one or replace the throw.
            await this.noteUserWithdrawal(connection, claimed, 'throw');
            throw error;
          }
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
            // The reverse is already committed. Counting uses this connection so a
            // one-slot pool is not asked for a second one while the lock is held.
            // The same event key as crash recovery, so the two cannot both add.
            await this.noteUserWithdrawal(connection, claimed, 'refused', code, `withdraw:${claimed.id}:${attempt}`);
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
          // once and squares the book. If the receipt was saved, the rail is not
          // asked again. If the crash came before the receipt was saved, the
          // attempt is still `requested` and the repeat asks the rail for the
          // status of the original key; it never calls `payout` again.
          assertStoredTransition('held', 'sent');
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
          // A replay of a stored acceptance (`accepted` was already set) did not
          // call the rail again, so it must not reset a streak earned since.
          if (!accepted) await this.noteUserWithdrawal(connection, claimed, 'accepted');

          span.setAttribute('intafaced.amount', formatAmount(claimed.amount));
          return { ...claimed, status: 'sent' as const, railRef: result.railRef };
        });
      } catch (error) {
        // The payout lock is already released. A screening refusal saves its case
        // here, after the claim transaction has rolled back, so the case survives.
        await settleGuardRefusal(error);
        throw error;
      }
    });
  }

  /**
   * Claim `(userId, clientRef)`, or return the existing claim.
   *
   * Same reasoning as `claimDeposit`, and the same refusal: a retry that names
   * the same client reference with a different amount, asset or destination is a
   * client bug, and resuming it against the ORIGINAL numbers would send money
   * somewhere the caller did not just ask for.
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
      // Seam: before the claim row is written, in the claim's own transaction, so
      // a refusal leaves no claim, hold or ledger entry. The advisory lock held by
      // `withdraw` serialises one (userId, clientRef), so this read cannot race.
      await this.guards.beforeUserMoneyWithdrawal({ tx, ...input, replay: await this.classifyWithdrawal(tx, input) });

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

      // Residual #8: a terminal `failed` row opens its next attempt as `pending`.
      // The reset happens HERE, after the guards ran and in the same transaction, so
      // the treasury advisory lock is still held while the row turns `pending`
      // (and starts to count as exposure). Resetting after the commit would let a
      // concurrent fresh withdrawal read this row as `failed`, i.e. not counted.
      if (existing.status === 'failed') {
        assertStoredTransition('failed', 'pending');
        await tx`
          UPDATE pay.withdrawals
             SET status = 'pending', failure_code = NULL, updated_at = now()
           WHERE id = ${existing.id} AND status = 'failed'
        `;
        return { ...existing, status: 'pending', failureCode: null };
      }

      return existing;
    });
  }

  /**
   * A user's withdrawal is one exit, so it counts against one key: `user:<id>`,
   * on this rail only. It does not add a failure for every merchant they own.
   * Only a rail-health refusal counts. A destination or customer refusal does
   * not. An adapter throw counts. A throw from the writer is logged and does
   * not change sent or pay.rail_failed.
   */
  private async noteUserWithdrawal(
    connection: Sql,
    claimed: { userId: string; rail: string },
    outcome: 'accepted' | 'refused' | 'throw',
    failureCode?: string | null,
    eventKey?: string,
  ): Promise<void> {
    if (!this.haltStore) return;
    const target = { level: 'user' as const, userId: claimed.userId };
    const source = payoutRailSourceKey(claimed.rail);
    try {
      if (outcome === 'accepted') {
        await this.haltStore.recordSuccess('payout', target, source, connection);
        return;
      }
      if (outcome === 'refused' && !isRailHealthFailureCode(failureCode)) return;
      await this.haltStore.recordFailure('payout', target, source, connection, eventKey);
    } catch (error) {
      noteAutoTripAccountError({
        op: outcome === 'accepted' ? 'recordSuccess' : 'recordFailure',
        scope: 'payout',
        target: userHaltKey(claimed.userId),
        sourceKey: source,
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /**
   * Fresh, replay or recovery for a withdrawal claim, from the stored row.
   *   none or `failed`  fresh (a failed row opens a NEW attempt with a new hold).
   *   `sent`            replay: the money is gone, the call returns the record.
   *   `held`            recovery: the hold is acknowledged. EXCEPT when the rail has already
   *                     answered for this attempt (`accepted` with a receipt, or `refused`):
   *                     finishing it is bookkeeping only (settle, or reverse), no rail call,
   *                     so it is a replay and a halt or limit must not freeze the user's money.
   *                     A `requested` attempt is still recovery: the retry does not call
   *                     `payout` again, but it asks the rail for the status of the original
   *                     key, so a halt on rail sends refuses it and the hold stays.
   *   `pending`         recovery only if the hold is already on the ledger (a ledger
   *                     throw can follow a remote commit); else fresh, nothing moved.
   */
  private async classifyWithdrawal(tx: Sql, input: { userId: string; clientRef: string }): Promise<GuardReplay> {
    const rows = await tx<Array<{ id: string; status: WithdrawalRecord['status']; attempts: number }>>`
      SELECT id, status, attempts FROM pay.withdrawals WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}
    `;
    const row = rows[0];
    if (!row || row.status === 'failed') return FRESH;
    if (row.status === 'sent') return { kind: 'replay', reason: 'withdrawal_already_sent' };
    if (row.status === 'held') {
      const [attempt] = await tx<Array<{ outcome: string; rail_ref: string | null }>>`
        SELECT outcome, rail_ref FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = ${row.id} AND attempt = ${row.attempts}
      `;
      // Mirror `withdraw`: an acceptance counts only with its receipt. A `requested`
      // attempt is resolved by a status query of the original key, never a second payout.
      const railAnswered = attempt?.outcome === 'refused' || (attempt?.outcome === 'accepted' && Boolean(attempt.rail_ref));
      return railAnswered
        ? { kind: 'replay', reason: 'withdrawal_rail_outcome_recorded' }
        : { kind: 'recovery', reason: 'withdrawal_hold_booked' };
    }
    return (await this.ledger.getTxByKey(`withdraw.hold:${row.id}:${row.attempts}`))
      ? { kind: 'recovery', reason: 'withdrawal_hold_booked' }
      : FRESH;
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
  /**
   * Status of a `requested` attempt, by its ORIGINAL provider key. Never calls
   * `payout`. Returns only an answer that names the original withdrawal:
   * `sent` with a receipt for the same amount and asset, or `not_sent`.
   * Everything else (no key, no status query, a query that throws or says
   * `unknown`) is `pay.rail_outcome_unknown` and the hold stays. A receipt for
   * another amount or asset is `pay.rail_amount_mismatch` and the hold stays.
   */
  private async queryRequestedWithdrawal(
    adapter: RailAdapter,
    instruction: SettlementInstruction,
    withdrawalId: string,
  ): Promise<{ status: 'sent'; railRef: string } | { status: 'not_sent' }> {
    const unknown = (message: string): never => {
      throw new PayError(message, 'pay.rail_outcome_unknown', { withdrawalId, state: 'requested' });
    };
    if (typeof adapter.payoutIdempotencyKey !== 'function' || typeof adapter.queryPayout !== 'function') {
      return unknown('Rail has no status query for the requested attempt; the hold stays');
    }
    let queried: PayoutRailStatus;
    try {
      queried = await withRailSpan(adapter.id, 'queryPayout', async () => adapter.queryPayout!(adapter.payoutIdempotencyKey!(instruction)));
    } catch {
      return unknown('Rail status query failed for the requested attempt; the hold stays');
    }
    if (queried.status === 'not_sent') return { status: 'not_sent' };
    if (queried.status !== 'sent') return unknown('Rail cannot say whether the requested attempt was sent; the hold stays');
    if (
      !queried.railRef?.trim() ||
      (queried.amount !== null && queried.amount !== instruction.amount) ||
      (queried.assetId !== null && queried.assetId !== instruction.assetId)
    ) {
      throw new PayError('Rail status does not match the held withdrawal', 'pay.rail_amount_mismatch', {
        withdrawalId,
        state: 'requested',
      });
    }
    return { status: 'sent', railRef: queried.railRef };
  }

  private async finalizeRailRefusal(claimed: WithdrawalRecord, failureCode: string, connection: Sql): Promise<void> {
    const attempt = claimed.attempts;
    const ledgerInput = {
      userId: claimed.userId,
      assetId: claimed.assetId,
      amount: claimed.amount,
      rail: claimed.rail,
      withdrawalId: `${claimed.id}:${attempt}`,
    };
    assertStoredTransition('held', 'failed');
    await postPayLedger(this.ledger, recipes.withdrawReverse(ledgerInput));
    await connection`
        UPDATE pay.withdrawals
           SET status = 'failed', attempts = attempts + 1,
               failure_code = ${failureCode}, updated_at = now()
         WHERE id = ${claimed.id} AND status = 'held'
      `;
  }

  // ── Wallet slice (S38) ─────────────────────────────────────────────────────

  private requireWallet(): WalletPay {
    if (!this.wallet) throw new PayError('Wallet rules are not configured', 'pay.wallet_unconfigured');
    return this.wallet;
  }

  estimateWithdrawalFee(input: { assetId: string; chain: string; address: string }) {
    return this.requireWallet().estimateFee(input);
  }

  remainingWithdrawalCap(userId: string, assetId: string) {
    return this.requireWallet().remainingCap(userId, assetId);
  }

  /**
   * Support read of one real withdrawal (`pay.withdrawals` and its rail
   * attempts). Another user's id is forbidden. The read posts nothing (WAL-0162).
   */
  async supportReadWithdrawal(withdrawalId: string, ownerUserId: string) {
    const rows = await this.sql<WithdrawalRow[]>`
      SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
        FROM pay.withdrawals WHERE id = ${withdrawalId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Withdrawal ${withdrawalId} not found`, 'pay.wallet_not_found');
    if (row.user_id !== ownerUserId) throw new PayError('This withdrawal belongs to another account', 'pay.wallet_forbidden');
    const attempts = await this.sql<Array<{ outcome: string; rail_ref: string | null }>>`
      SELECT outcome, rail_ref FROM pay.withdrawal_rail_attempts
       WHERE withdrawal_id = ${withdrawalId}
       ORDER BY attempt
    `;
    const mapped: WalletAttempt[] = attempts.map((attempt) => ({
      outcome: attempt.outcome === 'accepted' || attempt.outcome === 'requested' ? attempt.outcome : 'refused',
      railRef: attempt.rail_ref,
    }));
    return {
      withdrawalId: row.id,
      userId: row.user_id,
      label: await supportLabel(mapped, this.chainReader),
      controls: [] as string[],
      attempts: mapped,
      status: row.status,
    };
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

  /**
   * What the caller may still withdraw of one asset under the owner-set limit for their KYC tier. Refuses with the
   * guard's own typed codes where the guard would; an unwired reader is `pay.guard_withdrawal_limits_unwired`.
   */
  async withdrawalAllowance(userId: string, assetId: string): Promise<WithdrawalAllowanceView> {
    if (!this.withdrawalLimits) throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMITS_UNWIRED, 'unavailable');
    return this.withdrawalLimits.allowance(userId, assetId);
  }

  /** The caller's own withdrawals in the customer status vocabulary, one filtered page at a time. */
  async searchWithdrawals(userId: string, filter: WithdrawalHistoryFilter): Promise<WithdrawalHistoryPage> {
    if (!this.withdrawalHistory) throw new PayError('Withdrawal history is not wired', 'pay.withdrawal_history_unwired');
    return this.withdrawalHistory.search(userId, filter);
  }

  /** Can the caller start a withdrawal of this asset now, and if not, which checks say no. */
  async withdrawalEligibilityFor(userId: string, assetId: string): Promise<EligibilityView> {
    if (!this.withdrawalEligibility) throw new PayError('Withdrawal eligibility is not wired', 'pay.withdrawal_eligibility_unwired');
    return this.withdrawalEligibility.read(userId, assetId);
  }

  /**
   * Funds bought by card, ACH or PayPal and still held are tradable but cannot leave (W-withdraw-13). The limit is the
   * ledger's available balance minus what is held; the ledger stays the balance and nothing is booked here. A fresh ask
   * only, before the claim, so a refusal inserts nothing. A blank release period refuses with its own code.
   */
  private async assertNotHeldFromPurchase(input: { userId: string; assetId: string; amount: Amount }): Promise<void> {
    if (!this.purchaseHolds) return;
    const held = await this.purchaseHolds.held(input.userId, input.assetId);
    if (held.heldAmount === 0n) return;
    const available = await this.availableBalance(input.userId, input.assetId);
    const withdrawable = available > held.heldAmount ? available - held.heldAmount : 0n;
    if (input.amount <= withdrawable) return;
    const facts = { heldAmount: formatAmount(held.heldAmount), withdrawable: formatAmount(withdrawable) };
    if (!held.periodSet) {
      throw new PayError(
        'Part of your balance is held after a card, ACH or PayPal purchase and the release period is not set, so it cannot be withdrawn yet',
        'pay.purchase_hold_period_unset',
        facts,
      );
    }
    throw new PayError(
      `Part of your balance is held after a card, ACH or PayPal purchase until ${held.earliestReleaseAt}; you can withdraw up to ${facts.withdrawable} now`,
      'pay.withdrawal_amount_held',
      facts,
    );
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

function refuseSandboxLive(request: PostRequest): void {
  const live = liveAccountsIn(request);
  if (live.length === 0) return;
  throw new PayError('A sandbox payment cannot post to a live ledger account. NOTHING WAS POSTED.', 'pay.sandbox_live_account_refused', {
    accounts: live.map((account) => `${account.ownerType}:${account.ownerId}:${account.kind}`),
  });
}
