import { checkPayLedgerReceipt, postPayLedger } from './ledger-receipt.js';
import type { Sql } from 'postgres';
import { withPayoutLock, payoutTransaction } from './payout-admission.js';
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  LedgerError,
  parseAmount,
  provesPostNotCommitted,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { PayError, assertWithdrawalListLimit } from './payment-service.js';
import { liveAccountsIn } from './sandbox-ledger-guard.js';
import {
  FRESH,
  NOOP_GUARDS,
  composeGuards,
  PayGuardRefusal,
  settleGuardRefusal,
  type GuardReplay,
  type PartialPayGuards,
  type PayGuards,
} from './seams/guards.js';
import {
  GUARD_WITHDRAWAL_LIMITS_UNWIRED,
  type PublishedLimitsView,
  type WithdrawalAllowanceView,
  type WithdrawalLimitReader,
} from './limits/reader.js';
import { bankInternalWithdrawalInputSchema, internalWithdrawalTransferId, type BankInternalWithdrawalPort } from '@intafaced/contracts';
import {
  INTERNAL_RAIL,
  publicUnavailableReason,
  resolvePlatformDestination,
  type PublicUnavailableReason,
} from './withdrawals/internal.js';
import {
  assertStoredInternalTransition,
  assertStoredTransition,
  assertTransition,
  customerStatus,
  isCancellable,
  WITHDRAWAL_CANCELED_CODE,
  WITHDRAWAL_DROPPED_CODE,
  type DispatchJournal,
} from './withdrawals/status.js';
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
  /** The current attempt's dispatch journal outcome, when the read joined it (W-withdraw-07). Undefined: not read. */
  journal?: DispatchJournal;
  /** Moved into `held` under the journalling code. Undefined: not read. */
  dispatchJournaled?: boolean | null;
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
  /** Present only on reads that join the current attempt's journal row. */
  journal?: DispatchJournal;
  dispatch_journaled?: boolean | null;
}

/** A cancel's answer: the cancelled row, and whether a hold went back to the balance (`null`: the ledger could not say). */
export type CanceledWithdrawal = WithdrawalRecord & { holdReleased: boolean | null };

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

  /** Extra `beforeUserMoneyWithdrawal` guards run after `guards`, in the claim's transaction (the approval gate, W-withdraw-11). */
  readonly claimGuards?: PartialPayGuards;

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

  /**
   * svc-bank's internal settlement door (W-withdraw-14): a withdrawal to another account's platform address is one send
   * there, because `bankTransfer` is svc-bank's alone. Omitted: an internal withdrawal refuses before anything is claimed.
   */
  readonly internalSettlement?: BankInternalWithdrawalPort;
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
  private readonly internalSettlement: BankInternalWithdrawalPort | undefined;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly rails: RailRegistry,
    options: UserMoneyOptions,
  ) {
    this.creditableRails = new Set(options.operatorCreditRails);
    this.valueMovement = options.valueMovement ?? 'allow-sandbox';
    this.guards = options.claimGuards ? composeGuards(options.guards ?? NOOP_GUARDS, options.claimGuards) : (options.guards ?? NOOP_GUARDS);
    this.haltStore = options.haltStore;
    this.wallet = options.wallet;
    this.chainReader = options.chainReader ?? { confirm: async () => 'down' };
    this.withdrawalLimits = options.withdrawalLimits;
    this.withdrawalHistory = options.withdrawalHistory;
    this.withdrawalEligibility = options.withdrawalEligibility;
    this.purchaseHolds = options.purchaseHolds;
    this.internalSettlement = options.internalSettlement;
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
   * Post the ledger credit for a customer crypto deposit (W-deposit-05). THE ONE DEPOSIT ENGINE (D-128): the deposit record
   * (`custody/deposits/book.ts`) decides WHEN a transfer may credit (published depth, owner minimum) and owns the claim row,
   * so this posts nothing else and writes no `pay.deposits` row. The key is `deposit:crypto-native:<network>:<tx>:<index>`; a
   * repeat returns the first transaction. Operator credits stay refused for this rail.
   */
  async postCustodyDeposit(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    networkId: string;
    txHash: string;
    outputIndex: number;
  }): Promise<{ id: string }> {
    if (input.amount <= 0n) throw new PayError('Deposit amount must be positive', 'pay.invalid_amount');
    const rail = 'crypto-native';
    if (!this.rails.has(rail)) throw new PayError(`No rail adapter "${rail}"`, 'pay.rail_unknown');
    const railRef = `${input.networkId}:${input.txHash}:${input.outputIndex}`;
    return withMoneySpan('pay.deposit', { operation: 'deposit', rail, railRef, amount: formatAmount(input.amount) }, async () => {
      const tx = await postPayLedger(
        this.ledger,
        recipes.deposit({ userId: input.userId, assetId: input.assetId, amount: input.amount, rail, railRef }),
      );
      return { id: tx.id };
    });
  }

  /**
   * Post the reversal of a customer crypto deposit the chain took back (W-deposit-06): `depositReverse`, the inverse of the
   * credit `postCustodyDeposit` posted, keyed `deposit.reverse:crypto-native:<network>:<tx>:<index>` so a repeat returns the
   * first transaction. The deposit record decides WHEN (`custody/deposits/book.ts`); this posts nothing else. A balance that
   * can no longer cover it (the funds were spent) answers `unfunded` and posts nothing: never a negative balance, never a
   * partial take-back. That answer needs proof that nothing committed (`provesPostNotCommitted`: one attempt, the first post
   * under the key). After a retried post an earlier attempt may still land, so the same refusal answers `unsure`. `again`
   * (an earlier call may have posted, and the in-flight bound has passed) reads the key back first, and its post is then
   * the first that can still land.
   */
  async reverseCustodyDeposit(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    networkId: string;
    txHash: string;
    outputIndex: number;
    again: boolean;
  }): Promise<{ state: 'reversed'; id: string } | { state: 'unfunded' } | { state: 'unsure' }> {
    if (input.amount <= 0n) throw new PayError('Deposit amount must be positive', 'pay.invalid_amount');
    const rail = 'crypto-native';
    if (!this.rails.has(rail)) throw new PayError(`No rail adapter "${rail}"`, 'pay.rail_unknown');
    const railRef = `${input.networkId}:${input.txHash}:${input.outputIndex}`;
    return withMoneySpan(
      'pay.deposit_reverse',
      { operation: 'deposit_reverse', rail, railRef, amount: formatAmount(input.amount) },
      async () => {
        const request = recipes.depositReverse({
          userId: input.userId,
          assetId: input.assetId,
          amount: input.amount,
          rail,
          railRef,
          depositId: `${rail}:${railRef}`,
        });
        if (input.again) {
          const posted = await this.ledger.getTxByKey(request.idempotencyKey);
          if (posted) return { state: 'reversed' as const, id: (await checkPayLedgerReceipt(this.ledger, request, posted)).id };
        }
        try {
          const tx = await postPayLedger(this.ledger, request);
          return { state: 'reversed' as const, id: tx.id };
        } catch (err) {
          if (err instanceof LedgerError && err.code === 'ledger.insufficient_funds') {
            // A first post: proof that nothing committed. `again`: the key read back absent after the in-flight bound, which
            // is how the post-outcome contract decides that earlier attempts are dead, so this single-attempt refusal is the
            // only post that could still land, and it did not.
            return provesPostNotCommitted(err) ? { state: 'unfunded' as const } : { state: 'unsure' as const };
          }
          throw err;
        }
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
   * Everything `withdraw` checks before a row exists: the amount, the customer withdrawal gate for a fresh ask, a sandbox key,
   * the rail and the destination kind. Nothing is claimed or held. W-withdraw-11 runs it when a request is submitted, so a
   * withdrawal that could never run is refused up front and not after its approvals.
   */
  async preflightWithdrawal(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    rail: string;
    destination: { kind: string; ref: string };
    clientRef: string;
    keyEnv?: 'sandbox';
  }): Promise<RailAdapter> {
    if (input.amount <= 0n) throw new PayError('Withdrawal amount must be positive', 'pay.invalid_amount');
    const prior = await this.sql<Array<{ status: string }>>`
      SELECT status FROM pay.withdrawals
       WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}
    `;
    const status = prior[0]?.status;
    // A fresh ask is the customer door. A held or sent retry finishes the
    // original withdrawal and must not be refused by a later feature gate.
    const freshAsk = !status || status === 'failed';
    // W-withdraw-14: an account's address on the platform never goes out on a chain to come straight back. `withdrawal.create`
    // sends it to the internal branch; any other door that reaches here (an approval request, held at submission) is refused.
    if (freshAsk && (await resolvePlatformDestination(this.sql, input.userId, input.destination)).kind !== 'external') {
      throw new PayError(
        'That address is an account on the platform; send it inside INTAFACED from Withdraw',
        'pay.withdrawal_platform_address',
      );
    }
    if (this.wallet) {
      if (freshAsk) {
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
    return adapter;
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
  async withdraw(
    input: {
      userId: string;
      assetId: string;
      amount: Amount;
      rail: string;
      destination: { kind: string; ref: string };
      clientRef: string;
      /** A sandbox API key cannot debit a live balance. */
      keyEnv?: 'sandbox';
    },
    /**
     * `stopAfterHold` (W-withdraw-11, hold at submission): run the claim and post the hold, then stop. The row stays
     * `pending` with its hold booked, the state a crash between the hold and the rail already leaves, so a later `withdraw`
     * on the same client reference resumes it and `cancelWithdrawal` can give the hold back. The rail is never asked.
     */
    options: { stopAfterHold?: boolean } = {},
  ): Promise<WithdrawalRecord> {
    const adapter = await this.preflightWithdrawal(input);

    return withMoneySpan('pay.withdraw', { operation: 'withdraw', rail: input.rail, amount: formatAmount(input.amount) }, async (span) => {
      try {
        return await withPayoutLock(this.sql, `withdraw:${JSON.stringify([input.userId, input.clientRef])}`, async (connection) => {
          // A fresh ask (no row) and a finished refusal (`failed`) are refused
          // before the claim, so a blocked rail inserts nothing and does not
          // reopen a failed row. An existing `pending` row is still refused
          // after the claim, below. `sent` and `held` skip this check.
          const [priorClaim] = await connection<Array<{ status: string; failure_code: string | null }>>`
            SELECT status, failure_code FROM pay.withdrawals
             WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}
          `;
          // The customer cancelled this one. The same reference never reopens it; a new one is a new withdrawal.
          // The cancel writes its intent on a `pending` row before it reverses anything, so a row still `pending` that
          // carries the code is a cancel that crashed part-way: it is cancelled too, never resumed as a send.
          if (priorClaim?.failure_code === WITHDRAWAL_CANCELED_CODE) {
            throw new PayError('This withdrawal was cancelled; start a new one with a new client reference', 'pay.withdrawal_canceled');
          }
          const fresh = !priorClaim || priorClaim.status === 'failed';
          if (fresh) this.refuseFreshWithdrawal(adapter);

          let claimed = await this.claimWithdrawal(input, connection, fresh, options.stopAfterHold === true);

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
            // The hold is booked and the row is still `pending`: stop here when the caller asked to. No send is journalled
            // for it, so the answer can say it may be cancelled.
            if (options.stopAfterHold) return { ...claimed, journal: null };
            // `dispatch_journaled`: from here every send of this attempt is journalled `requested` before the rail is asked,
            // so a held row with no journal row for its attempt provably sent nothing and may be cancelled (W-withdraw-07).
            await connection`
          UPDATE pay.withdrawals SET status = 'held', failure_code = NULL, dispatch_journaled = true, updated_at = now()
           WHERE id = ${claimed.id} AND status = 'pending'
        `;
          }
          if (options.stopAfterHold) return claimed;

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
   * Whether an address is another account's on the platform, the caller's own, or neither (W-withdraw-14). Read from this
   * service's own deposit address tables; it never names the other account, and never says an address is frozen.
   */
  async platformDestination(
    userId: string,
    destination: { kind: string; ref: string },
  ): Promise<{ kind: 'internal' | 'self' | 'external' } | { kind: 'unavailable'; reason: PublicUnavailableReason }> {
    const place = await resolvePlatformDestination(this.sql, userId, destination);
    return place.kind === 'unavailable' ? { kind: 'unavailable', reason: publicUnavailableReason(place.reason) } : { kind: place.kind };
  }

  /**
   * A withdrawal to another account's deposit address on the platform (W-withdraw-14). It settles inside the book, at once
   * and with no network fee, as ONE svc-bank send from the sender's main account to the receiver's (svc-bank owns
   * `bankTransfer`; this service never posts it). No rail is asked and no hold is placed: the send itself takes the money
   * from the sender's available balance, so a hold first would take it twice.
   *
   * The claim is the ordinary one (`claimWithdrawal`, rail `internal`), so every withdrawal guard still runs in its
   * transaction: approvals, the allowlist, screening, the limits, the merchant controls and the halts. Three checks belong
   * to sends that leave custody and skip this rail: the wallet door (`preflightWithdrawal`: stored chain destination,
   * network fee, travel rule, cooling, cap on holds), the custody transaction policy (nothing is signed) and treasury
   * exposure (nothing leaves). A frozen account is refused by svc-bank, which asks identity whether the sender can send.
   *
   * ONE SEND PER WITHDRAWAL. svc-bank's key is the withdrawal row's own id (`withdraw:<id>`), and the row is unique per
   * person and client reference, so a retry after a lost answer is the same send and posts once.
   *
   *   1. The send is journalled `requested` before svc-bank is asked. From then on the row cannot be cancelled and a retry
   *      is a recovery that asks svc-bank again under the same key.
   *   2. `posted`: the journal and the row turn `accepted` and `sent` together.
   *   3. `refused`: svc-bank proved nothing was posted under the key, so the journal and the row turn `refused` and `failed`
   *      together, and nothing has to be put back.
   *   4. Anything else is unknown: the row stays `pending` with its journal `requested`, and the caller hears
   *      `pay.rail_outcome_unknown`. Only a retry with the same client reference finishes it.
   *
   * IF THIS CRASHES after the claim and before the journal, nothing was asked: the row is a plain `pending` claim, and the
   * customer can cancel it or retry it. After the journal and before the answer is saved, the money may have moved: the
   * retry asks svc-bank under the same key and saves its answer. Nobody's funds are stranded: they are either still in the
   * sender's balance or in the receiver's, under one ledger transaction.
   */
  async withdrawInternal(input: {
    userId: string;
    assetId: string;
    amount: Amount;
    destination: { kind: string; ref: string };
    clientRef: string;
    /** A sandbox API key cannot debit a live balance. */
    keyEnv?: 'sandbox';
  }): Promise<WithdrawalRecord> {
    if (input.amount <= 0n) throw new PayError('Withdrawal amount must be positive', 'pay.invalid_amount');
    if (input.keyEnv === 'sandbox') {
      refuseSandboxLive(
        recipes.withdrawHold({
          userId: input.userId,
          assetId: input.assetId,
          amount: input.amount,
          rail: INTERNAL_RAIL,
          withdrawalId: input.clientRef,
        }),
      );
    }
    const bank = this.internalSettlement;
    if (!bank)
      throw new PayError('Internal settlement is not connected in this process; nothing was claimed', 'pay.internal_settlement_unwired');
    // svc-bank's contract for the asset and the amount is checked before anything is claimed, so a send svc-bank would never
    // take claims nothing. The people are checked once the receiver is known.
    const terms = bankInternalWithdrawalInputSchema.shape;
    if (!terms.assetId.safeParse(input.assetId).success) {
      throw new PayError('This asset cannot settle inside the platform', 'pay.internal_asset_unsupported');
    }
    if (!terms.amount.safeParse(formatAmount(input.amount)).success) {
      throw new PayError('This amount cannot settle inside the platform', 'pay.invalid_amount');
    }

    return withMoneySpan(
      'pay.withdraw',
      { operation: 'withdraw', rail: INTERNAL_RAIL, amount: formatAmount(input.amount) },
      async (span) => {
        try {
          return await withPayoutLock(this.sql, `withdraw:${JSON.stringify([input.userId, input.clientRef])}`, async (connection) => {
            const [prior] = await connection<Array<{ id: string; status: string; attempts: number; failure_code: string | null }>>`
            SELECT id, status, attempts, failure_code FROM pay.withdrawals
             WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}
          `;
            if (prior?.failure_code === WITHDRAWAL_CANCELED_CODE) {
              throw new PayError('This withdrawal was cancelled; start a new one with a new client reference', 'pay.withdrawal_canceled');
            }
            const fresh = !prior || prior.status === 'failed';
            // Asked before: the row's current attempt is journalled, so svc-bank may already have posted it. A `pending` row
            // with no journal (a crash between the claim and the journal) asked nothing and is refused like a new send.
            const asked =
              prior?.status === 'pending' &&
              (
                await connection`
                SELECT 1 FROM pay.withdrawal_rail_attempts
                 WHERE withdrawal_id = ${prior.id} AND attempt = ${prior.attempts}
              `
              ).length > 0;

            // Who holds the address, from this service's own tables. An address is never handed to another account, so a
            // resumed send names the same receiver. A frozen or expired address refuses a send that was never asked: one
            // already asked of svc-bank may have posted, and only svc-bank's answer under the same key can finish it.
            const place = await resolvePlatformDestination(connection, input.userId, input.destination);
            if (place.kind === 'self') {
              throw new PayError(
                'That address is one of your own on the platform; a withdrawal to yourself is refused',
                'pay.withdrawal_self_send',
              );
            }
            if (place.kind === 'external') {
              throw new PayError('That address belongs to no account on the platform', 'pay.internal_destination_external');
            }
            if (place.kind === 'unavailable' && (!asked || place.toUserId === null)) {
              throw new PayError(
                'That platform address cannot take a transfer now; nothing was sent',
                'pay.internal_destination_unavailable',
                {
                  reason: publicUnavailableReason(place.reason),
                },
              );
            }
            const toUserId = place.toUserId!;

            const claimed = await this.claimWithdrawal({ ...input, rail: INTERNAL_RAIL }, connection, fresh);
            // Already settled: the money moved once, and asking again would only repeat the same answer.
            if (claimed.status === 'sent') return claimed;
            if (claimed.status !== 'pending') {
              throw new PayError('An internal withdrawal is never held; its state is unknown', 'pay.rail_outcome_unknown', {
                withdrawalId: claimed.id,
              });
            }
            const attempt = claimed.attempts;

            // The journal goes down before svc-bank is asked: from here a cancel refuses and a retry is a recovery.
            await connection`
            INSERT INTO pay.withdrawal_rail_attempts(withdrawal_id, attempt, outcome)
            VALUES (${claimed.id}, ${attempt}, 'requested') ON CONFLICT DO NOTHING
          `;
            const answer = await bank.settle({
              transferId: internalWithdrawalTransferId(claimed.id),
              fromUserId: claimed.userId,
              toUserId,
              assetId: claimed.assetId,
              amount: formatAmount(claimed.amount),
            });

            if (answer.state === 'posted') {
              assertStoredInternalTransition('pending', 'sent');
              await payoutTransaction(connection, async (tx) => {
                await tx`
                UPDATE pay.withdrawal_rail_attempts SET outcome = 'accepted', rail_ref = ${answer.ledgerTxId}
                 WHERE withdrawal_id = ${claimed.id} AND attempt = ${attempt}
              `;
                await tx`
                UPDATE pay.withdrawals SET status = 'sent', rail_ref = ${answer.ledgerTxId}, failure_code = NULL, updated_at = now()
                 WHERE id = ${claimed.id} AND status = 'pending'
              `;
              });
              span.setAttribute('intafaced.amount', formatAmount(claimed.amount));
              return { ...claimed, status: 'sent' as const, railRef: answer.ledgerTxId, failureCode: null, journal: 'accepted' as const };
            }

            if (answer.state === 'refused') {
              assertStoredInternalTransition('pending', 'failed');
              // Nothing was posted, so nothing is put back. `attempts` moves on, so a retry of the same reference journals anew.
              await payoutTransaction(connection, async (tx) => {
                await tx`
                UPDATE pay.withdrawal_rail_attempts SET outcome = 'refused'
                 WHERE withdrawal_id = ${claimed.id} AND attempt = ${attempt} AND outcome = 'requested'
              `;
                await tx`
                UPDATE pay.withdrawals
                   SET status = 'failed', failure_code = ${answer.code}, attempts = attempts + 1, updated_at = now()
                 WHERE id = ${claimed.id} AND status = 'pending'
              `;
              });
              throw new PayError('The transfer inside the platform was refused; nothing moved', 'pay.internal_settlement_refused', {
                withdrawalId: claimed.id,
                failureCode: answer.code,
              });
            }

            throw new PayError(
              'The transfer inside the platform has no answer yet; retry with the same client reference to finish it',
              'pay.rail_outcome_unknown',
              { withdrawalId: claimed.id, state: 'requested' },
            );
          });
        } catch (error) {
          // Same as `withdraw`: a screening refusal saves its case after the claim transaction has rolled back.
          await settleGuardRefusal(error);
          throw error;
        }
      },
    );
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
    fresh: boolean,
    stopAfterHold = false,
  ): Promise<WithdrawalRecord> {
    return payoutTransaction(connection, async (tx) => {
      // Seam: before the claim row is written, in the claim's own transaction, so
      // a refusal leaves no claim, hold or ledger entry. The advisory lock held by
      // `withdraw` serialises one (userId, clientRef), so this read cannot race.
      await this.guards.beforeUserMoneyWithdrawal({ tx, ...input, stopAfterHold, replay: await this.classifyWithdrawal(tx, input) });
      if (fresh) await this.assertNotHeldFromPurchase(tx, input);

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
    const rows = await tx<Array<{ id: string; status: WithdrawalRecord['status']; attempts: number; rail: string }>>`
      SELECT id, status, attempts, rail FROM pay.withdrawals WHERE user_id = ${input.userId} AND client_ref = ${input.clientRef}
    `;
    const row = rows[0];
    if (!row || row.status === 'failed') return FRESH;
    if (row.status === 'sent') return { kind: 'replay', reason: 'withdrawal_already_sent' };
    // An internal withdrawal has no hold. Once its send was asked of svc-bank it may have posted, so the retry finishes it.
    if (row.rail === INTERNAL_RAIL && row.status === 'pending') {
      const [asked] = await tx`
        SELECT 1 FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = ${row.id} AND attempt = ${row.attempts}
      `;
      return asked ? { kind: 'recovery', reason: 'withdrawal_internal_send_asked' } : FRESH;
    }
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

  /**
   * Cancel one of the caller's own withdrawals (W-withdraw-07, wallet-withdraw-044).
   *
   * A `pending` row can be cancelled when no send attempt is on record. A `held` row only when the dispatch journal proves
   * nothing was sent (ENGINE S-10): it moved into `held` under the code that journals every send before it asks the rail
   * (`dispatch_journaled`), and its current attempt has no journal row. A journalled `requested` attempt is a send whose
   * outcome is unknown (a lost reply): the cancel is refused and the hold stays until the original outcome is known. An
   * `accepted` attempt was broadcast and cannot be reversed. A `sent` row is final. A cancel takes the same payout lock as
   * `withdraw`, so the lock decides a race between the two and the loser gets the typed refusal.
   *
   * A hold can exist on a `pending` row too (the ledger posted it and the process died before the row turned `held`, or the
   * hold was booked at submission). The reverse is keyed on the attempt, so a repeat posts it once. Whether the hold exists
   * is read from the ledger; a read that fails refuses the cancel rather than guessing. A cancelled row is stored as `failed`
   * with `WITHDRAWAL_CANCELED_CODE`; a second cancel returns the same record.
   */
  async cancelWithdrawal(input: { userId: string; withdrawalId: string }): Promise<CanceledWithdrawal> {
    const [found] = await this.sql<WithdrawalRow[]>`
      SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
        FROM pay.withdrawals WHERE id = ${input.withdrawalId} AND user_id = ${input.userId}
    `;
    // Another account's id reads the same as no id.
    if (!found) throw new PayError('No such withdrawal', 'pay.withdrawal_not_found');
    return withPayoutLock(this.sql, `withdraw:${JSON.stringify([input.userId, found.client_ref])}`, async (connection) => {
      const [row] = await connection<WithdrawalRow[]>`
        SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at,
               dispatch_journaled
          FROM pay.withdrawals WHERE id = ${input.withdrawalId}
      `;
      const current = toWithdrawal(row!);
      const shown = customerStatus(current.status, current.failureCode);
      const holdKey = `${current.id}:${current.attempts}`;
      if (shown === 'canceled') {
        // A repeat: report whether the first one gave a hold back, read from the ledger by the reverse's own key.
        let released: boolean | null;
        try {
          released = (await this.ledger.getTxByKey(`withdraw.reverse:${holdKey}`)) !== null;
        } catch {
          released = null;
        }
        return { ...current, holdReleased: released };
      }
      // A row still `pending` or `held` with the cancel code is a cancel that wrote its intent and stopped before it finished: resume it.
      const resuming = current.failureCode === WITHDRAWAL_CANCELED_CODE;
      const refuse = (reason: string, state: string = shown): never => {
        throw new PayError(reason, 'pay.withdrawal_not_cancellable', { withdrawalId: current.id, state });
      };
      if (current.status === 'sent') return refuse('The withdrawal was sent and cannot be reversed');
      if (current.status === 'failed') return refuse('The withdrawal already failed and its funds are back in the balance');
      const [attempt] = await connection<Array<{ outcome: string }>>`
        SELECT outcome FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = ${current.id} AND attempt = ${current.attempts}
      `;
      if (attempt?.outcome === 'accepted') return refuse('The withdrawal was broadcast and cannot be reversed', 'broadcast');
      if (attempt?.outcome === 'requested') {
        return refuse('A send was asked for and its outcome is unknown; the withdrawal stays held until it is known', 'dispatching');
      }
      if (attempt) return refuse('The withdrawal has a send attempt on record and cannot be cancelled');
      if (current.status === 'held' && row!.dispatch_journaled !== true) {
        return refuse('The withdrawal was held before sends were journalled, so whether it was sent is unknown; it stays held');
      }
      // The same rule the reads show as `cancellable`, so the page and the cancel never disagree (a held row carrying a
      // refusal code is a refusal being put back, not something to cancel).
      if (!isCancellable(current.status, current.failureCode, null, row!.dispatch_journaled)) {
        return refuse('The withdrawal is being put back after a refusal and cannot be cancelled');
      }
      // Checked before anything is posted: an illegal move throws and posts nothing.
      assertTransition(current.status === 'held' ? 'held' : 'requested', 'canceled');
      let holdBooked: boolean;
      try {
        holdBooked = (await this.ledger.getTxByKey(`withdraw.hold:${holdKey}`)) !== null;
      } catch (error) {
        throw new PayError(
          `Withdrawal hold could not be read; the withdrawal stays ${current.status}: ${error instanceof Error ? error.message : 'ledger error'}`,
          'pay.ledger_outcome_unknown',
          { withdrawalId: current.id },
        );
      }
      // A held row's hold was acknowledged before the row turned held. None on the ledger is a broken record: refuse rather
      // than credit funds that were never held.
      if (current.status === 'held' && !holdBooked) return refuse('The withdrawal has no hold on the ledger to give back');
      // The intent goes down BEFORE the reverse, while the row is still `pending` or `held`: from here `withdraw` refuses
      // this client reference, so a crash after the reverse can never let a retry send funds the reverse already returned.
      if (!resuming) {
        await connection`
          UPDATE pay.withdrawals SET failure_code = ${WITHDRAWAL_CANCELED_CODE}, updated_at = now()
           WHERE id = ${current.id} AND status = ${current.status}::pay.withdrawal_status
        `;
      }
      if (holdBooked) {
        try {
          await postPayLedger(
            this.ledger,
            recipes.withdrawReverse({
              userId: current.userId,
              assetId: current.assetId,
              amount: current.amount,
              rail: current.rail,
              withdrawalId: holdKey,
            }),
          );
        } catch (error) {
          throw new PayError(
            `Withdrawal ledger outcome is unknown; the withdrawal stays ${current.status}: ${error instanceof Error ? error.message : 'ledger error'}`,
            'pay.ledger_outcome_unknown',
            { withdrawalId: current.id },
          );
        }
      }
      await connection`
        UPDATE pay.withdrawals SET status = 'failed', failure_code = ${WITHDRAWAL_CANCELED_CODE}, updated_at = now()
         WHERE id = ${current.id} AND status = ${current.status}::pay.withdrawal_status
      `;
      return { ...current, status: 'failed', failureCode: WITHDRAWAL_CANCELED_CODE, holdReleased: holdBooked };
    });
  }

  /**
   * Return a held withdrawal whose chain transaction was dropped (W-custody-ops-12). The custody desk has already shown
   * the evidence (a drop the chain saw take the nonce) and a second founder has approved; this method only posts. It takes
   * the same payout lock as `withdraw` and `cancelWithdrawal`, so a send resuming on the same client reference cannot
   * interleave. Only a `held` row whose hold is on the ledger can be reversed. The reverse is keyed on the attempt, the
   * same key a rail refusal uses, so it posts once however often it runs, and the row then reads `failed` with
   * `WITHDRAWAL_DROPPED_CODE` and a new attempt number. A second call on that row returns it unchanged. `expectedAttempt` is the
   * attempt the evidence was about; a row on any other attempt (a customer retry) is refused.
   */
  async reverseDroppedWithdrawal(input: { withdrawalId: string; expectedAttempt: number }): Promise<WithdrawalRecord> {
    const [found] = await this.sql<WithdrawalRow[]>`
      SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
        FROM pay.withdrawals WHERE id = ${input.withdrawalId}
    `;
    if (!found) throw new PayError('No such withdrawal', 'pay.withdrawal_not_found');
    return withPayoutLock(this.sql, `withdraw:${JSON.stringify([found.user_id, found.client_ref])}`, async (connection) => {
      const [row] = await connection<WithdrawalRow[]>`
        SELECT id, user_id, asset_id, amount, rail, destination, client_ref, rail_ref, attempts, failure_code, status, created_at
          FROM pay.withdrawals WHERE id = ${input.withdrawalId}
      `;
      const current = toWithdrawal(row!);
      if (current.status === 'failed' && current.failureCode === WITHDRAWAL_DROPPED_CODE) return current;
      if (current.status !== 'held') {
        throw new PayError('Only a held withdrawal can be reversed after its transaction was dropped', 'pay.withdrawal_not_reversible', {
          withdrawalId: current.id,
          state: customerStatus(current.status, current.failureCode),
        });
      }
      // A customer retry opens a new attempt with a new hold and a new send. Evidence is about one attempt only, so it never
      // returns the funds of another.
      if (current.attempts !== input.expectedAttempt) {
        throw new PayError('The withdrawal is no longer on the attempt this reverse was approved for', 'pay.withdrawal_not_reversible', {
          withdrawalId: current.id,
          state: 'held',
        });
      }
      let holdBooked: boolean;
      try {
        holdBooked = (await this.ledger.getTxByKey(`withdraw.hold:${current.id}:${current.attempts}`)) !== null;
      } catch (error) {
        throw new PayError(
          `Withdrawal hold could not be read; the withdrawal stays held: ${error instanceof Error ? error.message : 'ledger error'}`,
          'pay.ledger_outcome_unknown',
          { withdrawalId: current.id },
        );
      }
      // No hold on the ledger means nothing to give back: refuse instead of crediting funds that were never held.
      if (!holdBooked) {
        throw new PayError('The withdrawal has no hold on the ledger to reverse', 'pay.withdrawal_not_reversible', {
          withdrawalId: current.id,
          state: 'held',
        });
      }
      assertStoredTransition('held', 'failed');
      try {
        await postPayLedger(
          this.ledger,
          recipes.withdrawReverse({
            userId: current.userId,
            assetId: current.assetId,
            amount: current.amount,
            rail: current.rail,
            withdrawalId: `${current.id}:${current.attempts}`,
          }),
        );
      } catch (error) {
        throw new PayError(
          `Withdrawal ledger outcome is unknown; the withdrawal stays held: ${error instanceof Error ? error.message : 'ledger error'}`,
          'pay.ledger_outcome_unknown',
          { withdrawalId: current.id },
        );
      }
      await connection`
        UPDATE pay.withdrawals
           SET status = 'failed', attempts = attempts + 1, failure_code = ${WITHDRAWAL_DROPPED_CODE}, updated_at = now()
         WHERE id = ${current.id} AND status = 'held'
      `;
      return { ...current, status: 'failed', attempts: current.attempts + 1, failureCode: WITHDRAWAL_DROPPED_CODE };
    });
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

  /** One row with its current attempt's journal outcome, so the customer sees `held`, `dispatching` or `broadcast` (W-withdraw-07). */
  async getWithdrawal(withdrawalId: string): Promise<WithdrawalRecord> {
    const rows = await this.sql<WithdrawalRow[]>`
      SELECT w.id, w.user_id, w.asset_id, w.amount, w.rail, w.destination, w.client_ref, w.rail_ref, w.attempts, w.failure_code,
             w.status, w.created_at, w.dispatch_journaled, a.outcome AS journal
        FROM pay.withdrawals w
        LEFT JOIN pay.withdrawal_rail_attempts a ON a.withdrawal_id = w.id AND a.attempt = w.attempts
       WHERE w.id = ${withdrawalId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Withdrawal ${withdrawalId} not found`, 'pay.withdrawal_not_found');
    return toWithdrawal(row);
  }

  async listWithdrawals(userId: string, limit?: number): Promise<WithdrawalRecord[]> {
    const page = assertWithdrawalListLimit(limit);
    const rows = await this.sql<WithdrawalRow[]>`
      SELECT w.id, w.user_id, w.asset_id, w.amount, w.rail, w.destination, w.client_ref, w.rail_ref, w.attempts, w.failure_code,
             w.status, w.created_at, w.dispatch_journaled, a.outcome AS journal
        FROM pay.withdrawals w
        LEFT JOIN pay.withdrawal_rail_attempts a ON a.withdrawal_id = w.id AND a.attempt = w.attempts
       WHERE w.user_id = ${userId} ORDER BY w.created_at DESC LIMIT ${page}
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

  /** The owner's withdrawal limits for every KYC tier (the verification ladder). No figure is invented for a tier left out. */
  async withdrawalTierLimits(): Promise<PublishedLimitsView> {
    if (!this.withdrawalLimits) throw new PayGuardRefusal(GUARD_WITHDRAWAL_LIMITS_UNWIRED, 'unavailable');
    return this.withdrawalLimits.published();
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
   * ledger's available balance minus what is held minus what this customer's other claimed withdrawals of the asset
   * are about to take (a `pending` row has not necessarily posted its hold yet, so the ledger cannot show it; if it
   * has, counting it twice only errs toward refusing). The ledger stays the balance and nothing is booked here.
   *
   * Runs in the claim transaction of a fresh ask, after a per-(customer, asset) lock that the claim's commit releases,
   * so two withdrawals under different client references cannot both read the same withdrawable amount. A refusal
   * rolls the claim back: no row, no ledger move. A blank release period refuses with its own code.
   */
  private async assertNotHeldFromPurchase(tx: Sql, input: { userId: string; assetId: string; amount: Amount }): Promise<void> {
    if (!this.purchaseHolds) return;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`purchase-hold:${input.userId}:${input.assetId}`}, 0))`;
    const held = await this.purchaseHolds.held(input.userId, input.assetId);
    if (held.heldAmount === 0n) return;
    const available = await this.availableBalance(input.userId, input.assetId);
    const [claimed] = await tx<Array<{ total: string }>>`
      SELECT coalesce(sum(amount), 0)::text AS total FROM pay.withdrawals
       WHERE user_id = ${input.userId} AND asset_id = ${input.assetId} AND status = 'pending'
    `;
    const free = available - held.heldAmount - parseAmount(claimed?.total ?? '0');
    const withdrawable = free > 0n ? free : 0n;
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
    ...('journal' in row ? { journal: row.journal ?? null } : {}),
    ...('dispatch_journaled' in row ? { dispatchJournaled: row.dispatch_journaled ?? null } : {}),
  };
}

function refuseSandboxLive(request: PostRequest): void {
  const live = liveAccountsIn(request);
  if (live.length === 0) return;
  throw new PayError('A sandbox payment cannot post to a live ledger account. NOTHING WAS POSTED.', 'pay.sandbox_live_account_refused', {
    accounts: live.map((account) => `${account.ownerType}:${account.ownerId}:${account.kind}`),
  });
}
