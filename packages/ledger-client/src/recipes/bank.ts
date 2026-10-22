import { sum, type Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { accountKey } from '../client.js';
import { earnPoolReserve, earnStakeAccount, houseFees, subAccountHold, userAvailable, userHold } from '../accounts.js';

/**
 * BANK RECIPES (§8.1).
 *
 * ⚠ SHARED-PACKAGE CHANGE — flagged deliberately.
 *
 * §15.2 normally wants a `packages/ledger-client` change as its own PR ahead of
 * the service that uses it. These five recipes arrived with svc-bank because
 * §8.1's "views + rails" has no rails without them: an internal transfer, an
 * earn deposit and withdrawal, funding a pool's yield reserve, and paying a
 * day's interest are five value movements no existing recipe expresses. They
 * are kept in their own file so the shared-package diff is reviewable — and
 * revertable — on its own.
 *
 * Native staking is NOT here: svc-token owns it via `stake` / `unstake` and
 * svc-bank does not duplicate it.
 *
 * Loans are not here either — and the claim this comment used to make, that they
 * "already existed" as `collateralLock` / `collateralRelease` / `liquidate`, was
 * wrong. Those three were unreachable stubs with no principal release, no debt
 * for a repayment to reduce and no liquidation ladder. §8.1's lending money paths
 * now live in `./loans.ts`, whose header sets out what each of them got wrong.
 */

const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requirePositive(name: string, value: Amount): void {
  if (value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

// ── Internal transfer (spaces) ───────────────────────────────────────────────

export interface BankTransferInput {
  /** Business identity of the movement — a schedule id, or a one-off transfer id. */
  transferId: string;
  /**
   * Which firing of `transferId` this is. A standing order is `transferId` +
   * occurrence index; a one-off transfer is occurrence 0.
   *
   * This is the whole idempotency story for the scheduler: the key is derived
   * from the schedule and the period, never from a clock reading or a UUID, so
   * two workers that both decide the same period is due produce the same key
   * and the ledger collapses them into one transfer.
   */
  occurrence: number;
  /** Source account. A space resolves to one of these; svc-bank owns the mapping. */
  from: AccountRef;
  to: AccountRef;
  amount: Amount;
  /** Machine-readable reason suffix, e.g. 'scheduled' or 'manual'. */
  kind: 'manual' | 'scheduled';
  /**
   * Which operation owns `transferId`. It becomes part of the idempotency key, so an own-space
   * transfer, a person-to-person payment, a standing-order firing and a rail send can never be
   * the same key even when a caller hands two of them the same id.
   *
   * Optional only so existing callers keep compiling and keep their keys. Without it the key is
   * the legacy shared `bank.transfer:` space, which is the F-2.1 collision. Every caller should
   * name its space. `sched` goes with `kind: 'scheduled'` and nothing else does.
   */
  keySpace?: BankTransferKeySpace;
}

/**
 * One key space per operation that books a bank transfer.
 *
 *   own    a user moving value between their own spaces (a one-off transfer)
 *   p2p    a user paying another user (personal pay, pay-by-handle, a paid request)
 *   sched  one firing of one standing order (`transferId` is the schedule id)
 *   rail   a send to a payment rail boundary, and its reversal
 */
export const BANK_TRANSFER_KEY_SPACES = ['own', 'p2p', 'sched', 'rail'] as const;
export type BankTransferKeySpace = (typeof BANK_TRANSFER_KEY_SPACES)[number];

function requireOccurrence(occurrence: number): void {
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new InvalidEntryError(`Occurrence must be a non-negative integer, got ${occurrence}`);
  }
}

/**
 * The idempotency key a bank transfer posts under: `bank.transfer.<space>:<transferId>:<occurrence>`.
 * Read this key back with `getTxByKey` after a lost reply; never rebuild it by hand.
 */
export function bankTransferKey(space: BankTransferKeySpace, transferId: string, occurrence: number): string {
  if (!BANK_TRANSFER_KEY_SPACES.includes(space)) throw new InvalidEntryError(`Unknown bank transfer key space ${String(space)}`);
  if (transferId.trim() === '') throw new InvalidEntryError('A bank transfer needs a transfer id');
  requireOccurrence(occurrence);
  return `bank.transfer.${space}:${transferId}:${occurrence}`;
}

/**
 * The key every bank transfer used before key spaces: `bank.transfer:<id>:<occurrence>`. A caller
 * that may meet a booking from before its move to a key space looks this key up as well. It is
 * what a recipe call with no `keySpace` still posts.
 */
export function legacyBankTransferKey(transferId: string, occurrence: number): string {
  return `bank.transfer:${transferId}:${occurrence}`;
}

/**
 * Move value between two accounts inside the book.
 *
 * This recipe takes `AccountRef`s rather than user ids because a "space" is not
 * one shape of account: a user's primary space IS their `userAvailable`
 * account, and every named space is a `subaccount` available account. Resolving
 * that mapping is svc-bank's job (it owns the `spaces` table); asserting the
 * movement is well-formed is this recipe's.
 *
 * D-149 (2026-10-22): a business space is a sub-account, so a business bill
 * payment is this recipe with a `subAccountAvailable` source and the rail
 * boundary as destination, exactly like a personal bill. No separate business
 * debit recipe exists. Fees, arrival times and payment limits for bill methods
 * are owner values and are not set here.
 *
 * Cross-asset transfers are rejected outright rather than silently priced —
 * converting between assets is a trade, and a trade has an execution price this
 * function has no business inventing.
 */
export function bankTransfer(input: BankTransferInput): PostRequest {
  requirePositive('transfer amount', input.amount);

  if (input.from.assetId !== input.to.assetId) {
    throw new InvalidEntryError(
      `A transfer cannot change asset (${input.from.assetId} → ${input.to.assetId}); route it through a conversion instead`,
    );
  }
  if (accountKey(input.from) === accountKey(input.to)) {
    throw new InvalidEntryError('A transfer must have two different accounts');
  }
  if (input.from.kind !== 'available' || input.to.kind !== 'available') {
    // A transfer that could target `hold`/`escrow`/`stake` would be a way to
    // create a locked position without the lock's own recipe and its rules.
    throw new InvalidEntryError('Transfers move between available accounts only — locks have their own recipes');
  }
  requireOccurrence(input.occurrence);
  if (input.keySpace !== undefined && (input.keySpace === 'sched') !== (input.kind === 'scheduled')) {
    throw new InvalidEntryError(`Key space ${input.keySpace} does not go with a ${input.kind} transfer`);
  }

  return {
    idempotencyKey:
      input.keySpace === undefined
        ? legacyBankTransferKey(input.transferId, input.occurrence)
        : bankTransferKey(input.keySpace, input.transferId, input.occurrence),
    module: 'bank',
    reason: input.kind === 'scheduled' ? 'bank.transfer.scheduled' : 'bank.transfer.manual',
    meta: { transferId: input.transferId, occurrence: input.occurrence },
    entries: [credit(input.from, input.amount), debit(input.to, input.amount)],
  };
}

// ── Earn (§8.1) ──────────────────────────────────────────────────────────────

export interface EarnPositionInput {
  positionId: string;
  poolId: string;
  userId: string;
  assetId: string;
  amount: Amount;
}

/**
 * Open an earn position: value moves from the user's available balance into
 * their own `stake` account.
 *
 * It stays the user's the entire time — `stake` is an account kind the user
 * owns, and `assertPairedLocks` proves the value came from that same user's
 * available balance in the same transaction. A pool that took custody into a
 * house account would look identical to a user until the day it did not.
 */
export function earnDeposit(input: EarnPositionInput): PostRequest {
  requirePositive('earn deposit amount', input.amount);
  return {
    idempotencyKey: `bank.earn.deposit:${input.positionId}`,
    module: 'bank',
    reason: 'bank.earn.deposited',
    meta: { positionId: input.positionId, poolId: input.poolId },
    entries: [
      credit(userAvailable(input.userId, input.assetId), input.amount),
      debit(earnStakeAccount(input.userId, input.assetId, input.positionId), input.amount),
    ],
  };
}

/** Close an earn position — the principal returns to available. */
export function earnWithdraw(input: EarnPositionInput): PostRequest {
  requirePositive('earn withdrawal amount', input.amount);
  return {
    idempotencyKey: `bank.earn.withdraw:${input.positionId}`,
    module: 'bank',
    reason: 'bank.earn.withdrawn',
    meta: { positionId: input.positionId, poolId: input.poolId },
    entries: [
      credit(earnStakeAccount(input.userId, input.assetId, input.positionId), input.amount),
      debit(userAvailable(input.userId, input.assetId), input.amount),
    ],
  };
}

export interface EarnPoolFundInput {
  poolId: string;
  /** Identifies this funding event — a treasury transfer reference, a window id. */
  fundingId: string;
  assetId: string;
  amount: Amount;
  /** Defaults to the bank's own fee revenue. */
  from?: AccountRef;
}

/**
 * Put yield into a pool's reserve before it can be paid out.
 *
 * Interest is not minted. `earnInterest` debits users out of this reserve, so
 * an under-funded pool fails to accrue rather than paying out of thin air —
 * which is the correct failure, loudly, on the day the yield stops being real.
 *
 * A supplied source must already be the pool asset. Cross-asset funding is
 * rejected outright rather than silently priced — converting between assets is
 * a trade, and a trade has an execution price this function has no business
 * inventing.
 */
export function earnPoolFund(input: EarnPoolFundInput): PostRequest {
  requirePositive('pool funding amount', input.amount);
  if (input.from !== undefined && input.from.assetId !== input.assetId) {
    throw new InvalidEntryError(
      `A transfer cannot change asset (${input.from.assetId} → ${input.assetId}); route it through a conversion instead`,
    );
  }
  return {
    idempotencyKey: `bank.earn.fund:${input.poolId}:${input.fundingId}`,
    module: 'bank',
    reason: 'bank.earn.pool.funded',
    meta: { poolId: input.poolId, fundingId: input.fundingId },
    entries: [
      credit(input.from ?? houseFees('bank', input.assetId), input.amount),
      debit(earnPoolReserve(input.poolId, input.assetId), input.amount),
    ],
  };
}

export interface EarnInterestInput {
  poolId: string;
  /** A real Gregorian day, written `YYYY-MM-DD`. One accrual per pool per day, forever. */
  date: string;
  assetId: string;
  /** One entry per user. Zero-amount payouts must be filtered out by the caller. */
  payouts: ReadonlyArray<{ userId: string; amount: Amount }>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Gregorian leap year from the written year. Year 1 stays year 1. */
function gregorianLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

/**
 * Calendar index from the written digits. Year, month, and day are indexes,
 * not amounts, so they stay a small integer built from character codes.
 */
function writtenCalendarIndex(date: string, start: number, end: number): number {
  let index = 0;
  for (let i = start; i < end; i += 1) {
    index = index * 10 + (date.charCodeAt(i) - 48);
  }
  return index;
}

/**
 * A real calendar day, read from the written year, month, and day.
 * The original string is what the idempotency key keeps.
 */
function accrualCalendarDay(date: string): boolean {
  if (!ISO_DATE.test(date)) return false;
  const year = writtenCalendarIndex(date, 0, 4);
  const month = writtenCalendarIndex(date, 5, 7);
  const day = writtenCalendarIndex(date, 8, 10);
  if (day < 1) return false;
  const length = daysInGregorianMonth(year, month);
  return length !== undefined && day <= length;
}

function daysInGregorianMonth(year: number, month: number): number | undefined {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return gregorianLeapYear(year) ? 29 : 28;
    default:
      return undefined;
  }
}

/**
 * One day's interest for one pool, as a single atomic transaction.
 *
 * The key is `bank.interest:<poolId>:<date>` — a business key, per §5 of the
 * agent protocol. A scheduler that fires twice at midnight produces the same
 * key twice and the second post returns the first one's transaction. The date
 * in that key is the written calendar day. A string that is not one, such as
 * 2026-02-31, is refused, so it cannot sit beside a later correction as a
 * second accrual.
 *
 * One transaction for the whole pool rather than one per user is a deliberate
 * trade: it makes "did this pool accrue on the 3rd" a single unambiguous fact,
 * at the cost of an entry list that grows with the pool. svc-token splits its
 * yield distribution per recipient for the opposite reason (resumability across
 * thousands of stakers); here the day is the unit of truth, and a partially
 * accrued day would be worse than a retried one.
 *
 * §13 socket: when a pool outgrows one transaction, the key gains a deterministic
 * chunk index — `bank.interest:<poolId>:<date>:<chunk>` — which keeps the same
 * property per chunk. The shape is chosen so that change is additive.
 */
export function earnInterest(input: EarnInterestInput): PostRequest {
  if (!accrualCalendarDay(input.date)) {
    throw new InvalidEntryError(`Accrual date must be YYYY-MM-DD, got "${input.date}"`);
  }
  if (input.payouts.length === 0) {
    throw new InvalidEntryError('An interest accrual with no recipients is not a transaction');
  }
  for (const payout of input.payouts) requirePositive(`interest for ${payout.userId}`, payout.amount);

  const total = sum(input.payouts.map((p) => p.amount));

  return {
    idempotencyKey: `bank.interest:${input.poolId}:${input.date}`,
    module: 'bank',
    reason: 'bank.earn.interest',
    meta: { poolId: input.poolId, date: input.date, recipients: input.payouts.length },
    entries: [
      credit(earnPoolReserve(input.poolId, input.assetId), total),
      ...input.payouts.map((p) => debit(userAvailable(p.userId, input.assetId), p.amount)),
    ],
  };
}

// ── Business dual-control holds (bank.business / §31:811) ────────────────────

/** Hold pot paired to the debit available pot (primary user or named space). */
function businessApprovalHoldFor(from: AccountRef, approvalId: string): AccountRef {
  const purpose = `business-approval:${approvalId}`;
  if (from.kind !== 'available') {
    throw new InvalidEntryError('Business approval hold requires an available source pot');
  }
  if (from.ownerType === 'user') return userHold(from.ownerId, from.assetId, purpose);
  if (from.ownerType === 'subaccount') return subAccountHold(from.ownerId, from.assetId, purpose);
  throw new InvalidEntryError(`Business approval hold unsupported ownerType ${from.ownerType}`);
}

export interface BusinessApprovalHoldInput {
  /** Approval id — also the ledger purpose key. */
  approvalId: string;
  /** Debit space available pot (primary or named). */
  from: AccountRef;
  amount: Amount;
}

/**
 * Reserve value while a checker decides — available → purposed hold on the same owner.
 *
 * Without this, "pending approval" was only a row and the maker could still spend
 * the funds (or a concurrent transfer could empty the pot before approve).
 */
export function businessApprovalHold(input: BusinessApprovalHoldInput): PostRequest {
  requirePositive('business approval hold amount', input.amount);
  const hold = businessApprovalHoldFor(input.from, input.approvalId);
  if (input.from.assetId !== hold.assetId) {
    throw new InvalidEntryError('Business approval hold cannot change asset');
  }
  return {
    idempotencyKey: `bank.business.hold:${input.approvalId}`,
    module: 'bank',
    reason: 'bank.business.approval.held',
    meta: { approvalId: input.approvalId },
    entries: [credit(input.from, input.amount), debit(hold, input.amount)],
  };
}

/** Checker rejected or maker cancelled — hold returns to the debit pot. */
export function businessApprovalRelease(input: BusinessApprovalHoldInput): PostRequest {
  requirePositive('business approval release amount', input.amount);
  const hold = businessApprovalHoldFor(input.from, input.approvalId);
  return {
    idempotencyKey: `bank.business.release:${input.approvalId}`,
    module: 'bank',
    reason: 'bank.business.approval.released',
    meta: { approvalId: input.approvalId },
    entries: [credit(hold, input.amount), debit(input.from, input.amount)],
  };
}

export interface BusinessApprovalSettleInput {
  approvalId: string;
  /** Original debit space (defines the hold pot owner). */
  from: AccountRef;
  /** Credit destination available pot. */
  to: AccountRef;
  amount: Amount;
}

/** Checker approved — purposed hold → destination available (one atomic post). */
export function businessApprovalSettle(input: BusinessApprovalSettleInput): PostRequest {
  requirePositive('business approval settle amount', input.amount);
  if (input.to.kind !== 'available') {
    throw new InvalidEntryError('Business approval settle destination must be available');
  }
  if (input.from.assetId !== input.to.assetId) {
    throw new InvalidEntryError(`Business approval settle cannot change asset (${input.from.assetId} → ${input.to.assetId})`);
  }
  const hold = businessApprovalHoldFor(input.from, input.approvalId);
  return {
    idempotencyKey: `bank.business.settle:${input.approvalId}`,
    module: 'bank',
    reason: 'bank.business.approval.settled',
    meta: { approvalId: input.approvalId },
    entries: [credit(hold, input.amount), debit(input.to, input.amount)],
  };
}

// ── Business payroll (bank.business / §31:811) — all paid or none ────────────

export interface BusinessPayrollRecipient {
  to: AccountRef;
  amount: Amount;
}

export interface BusinessPayrollInput {
  /** Client-supplied run id. Retries reuse it; the ledger key is this id. */
  payrollId: string;
  /** Debit pot (primary or named space). */
  from: AccountRef;
  /** One line per recipient. Empty is not a transaction. */
  recipients: ReadonlyArray<BusinessPayrollRecipient>;
}

/**
 * Multi-recipient payroll as ONE ledger post.
 *
 * All recipients credit or none do: the book either accepts the whole entry
 * list or refuses it (insufficient funds on the source, a bad line). A loop of
 * `bankTransfer` would leave earlier workers paid and later ones unpaid — the
 * failure this recipe exists to make impossible.
 *
 * Same-asset only. A stables/fiat mix would need an FX rate this function has
 * no business inventing; the service refuses that as
 * `bank.business_payroll_rate_unset` before it reaches here.
 */
export function businessPayroll(input: BusinessPayrollInput): PostRequest {
  if (input.recipients.length === 0) {
    throw new InvalidEntryError('A payroll with no recipients is not a transaction');
  }
  if (input.from.kind !== 'available') {
    throw new InvalidEntryError('Payroll source must be an available account');
  }

  const seen = new Set<string>();
  seen.add(accountKey(input.from));
  for (const line of input.recipients) {
    requirePositive(`payroll for ${accountKey(line.to)}`, line.amount);
    if (line.to.kind !== 'available') {
      throw new InvalidEntryError('Payroll destinations must be available accounts — locks have their own recipes');
    }
    if (line.to.assetId !== input.from.assetId) {
      throw new InvalidEntryError(`Payroll cannot change asset (${input.from.assetId} → ${line.to.assetId}); rates are not invented here`);
    }
    const key = accountKey(line.to);
    if (seen.has(key)) {
      throw new InvalidEntryError('Payroll cannot pay the same account twice, or pay the source');
    }
    seen.add(key);
  }

  const total = sum(input.recipients.map((line) => line.amount));
  return {
    idempotencyKey: `bank.business.payroll:${input.payrollId}`,
    module: 'bank',
    reason: 'bank.business.payroll.settled',
    meta: { payrollId: input.payrollId, recipients: input.recipients.length },
    entries: [credit(input.from, total), ...input.recipients.map((line) => debit(line.to, line.amount))],
  };
}
