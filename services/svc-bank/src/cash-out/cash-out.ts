/**
 * CASH OUT (BK-ord-01, BK-xfer-08, BK-xfer-09, J-bank-03): turn part of the balance into money in one of the customer's
 * linked bank accounts.
 *
 * The customer enters an amount and picks a linked account. The entry checks come first, in this order: an amount above
 * zero, no more than the available balance (read from the ledger, never from a copy), and an account of theirs that is
 * still linked. The quote then says what stands in the way, first reason first:
 * - the account is not verified (`bank.linked_account_unverified`): only a banking partner can verify it;
 * - its cooling-off has no published length (`bank.offramp_cooling_unset`) or has not ended (`bank.offramp_cooling_active`);
 * - no banking partner pays out this asset to bank accounts (`bank.fiat_ramp_socket`, rail `rail.bank`).
 * With nothing in the way, the partner's own fee and the amount that arrives are shown. None is invented: with no partner
 * there is no price.
 *
 * Asking to cash out (behind the step-up scope) is kept whatever the answer. A request something stands in the way of is
 * kept `refused` with its reason, and nothing is held or posted. A request the partner can take is `processing`: the
 * amount leaves the available balance into this request's own hold (`withdraw.hold:cash-out:<id>`), and the partner is
 * asked to pay it, with the request id as its idempotency key. The partner then answers once, by its signed call:
 * - paid: `completed`, the hold settled to the partner's rail once (`withdraw.settle:cash-out:<id>`), with a signed receipt;
 * - not paid: `failed` with the partner's reason, the hold given back once (`withdraw.reverse:cash-out:<id>`);
 * - paid and later sent back by the receiving bank, in full or in part: `returned`, what came back credited once from the
 *   partner's rail (`deposit:<rail>:cash-out-return:<id>`), and what did not come back stays paid out.
 * There is no cancel once the partner has the payout: only the partner's answer closes it.
 *
 * If this crashes exactly here, whose funds are stranded? A request written `processing` before its hold, or held
 * before the partner was asked, is picked up by the same request id again (the customer's retry) or by the re-drive job,
 * and every ledger post is keyed by the request, so nothing is held or paid twice. Until then the amount sits in this
 * request's own hold, visible, never in another request's.
 *
 * The request id is the customer's business key for one ask: the same id on the same terms is the same request, and on
 * other terms, or from someone else, is `bank.ramp_conflict`.
 */
import type { PendingQuery, Row, Sql } from 'postgres';
import { InsufficientFundsError, formatAmount, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { BankError, type BankErrorCode } from '../errors.js';
import type { LinkedAccountService, LinkedAccountView } from '../linked-accounts/linked-accounts.js';
import { oneLine, signReceipt } from '../receipt-signing.js';
import { assertHoldsOpen, assertSecurityLockOpen, unconfiguredSecurityLock, type SecurityLockPort } from '../security-lock.js';
import { withSessionAdvisoryLock } from '../session-lock.js';
import type { CashOutPartner, PayoutFailure, PayoutReturn } from './payout-sim.js';
import { RailRecordError, type RailMovement } from './rail-records.js';

export interface CashOutAsk {
  readonly assetId: string;
  readonly amount: string;
  readonly linkedAccountId: string;
}

export interface CashOutQuoteView {
  readonly assetId: string;
  readonly amount: string;
  /** The ledger's available balance for the asset, as read for this quote. */
  readonly available: string;
  readonly account: LinkedAccountView;
  readonly rail: 'rail.bank';
  /** The partner's fee and the amount that arrives, in the currency it pays. Null while something stands in the way. */
  readonly fee: string | null;
  readonly receiveAmount: string | null;
  readonly receiveCurrency: string | null;
  /** What stands in the way, first reason first, or null when the partner can take it. */
  readonly blocker: BankErrorCode | null;
  /** The TEST label when the partner pricing it is the local stack's stand-in. */
  readonly standIn: string | null;
}

export const CASH_OUT_STATUSES = ['refused', 'processing', 'completed', 'failed', 'returned'] as const;
export type CashOutStatus = (typeof CASH_OUT_STATUSES)[number];

export interface CashOutRequestView {
  readonly requestId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly linkedAccountId: string;
  readonly rail: 'rail.bank';
  readonly status: CashOutStatus;
  /** Why it was not sent (refused only). */
  readonly refusalCode: string | null;
  readonly fee: string | null;
  readonly receiveAmount: string | null;
  readonly receiveCurrency: string | null;
  /** The partner's reference for the payout, once it has one. */
  readonly payoutRef: string | null;
  /** The ledger transaction that paid it out, once completed. */
  readonly ledgerTxId: string | null;
  /** The partner's reason: why it failed, or why it came back. */
  readonly failureCode: string | null;
  /** What came back to the balance, once returned. */
  readonly returnedAmount: string | null;
  /** What stays paid out: all of it once completed, the rest once part came back, else null. */
  readonly remainsPaidOut: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly returnedAt: string | null;
}

/** A receipt for a cash-out that was paid: the text, its SHA-256 and an HMAC-SHA256 signature over the same bytes. */
export interface CashOutReceipt {
  readonly fileName: string;
  readonly text: string;
  readonly ledgerTxId: string;
  readonly sha256: string;
  readonly signature: string;
}

interface RequestRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  linked_account_id: string;
  rail: 'rail.bank';
  status: CashOutStatus;
  refusal_code: string | null;
  payout_rail: string | null;
  payout_ref: string | null;
  fee: string | null;
  receive_amount: string | null;
  receive_currency: string | null;
  hold_ledger_tx_id: string | null;
  settle_ledger_tx_id: string | null;
  reverse_ledger_tx_id: string | null;
  failure_code: string | null;
  returned_amount: string | null;
  return_ledger_tx_id: string | null;
  created_at: Date;
  completed_at: Date | null;
  failed_at: Date | null;
  returned_at: Date | null;
}

type Reads = {
  readonly available: (userId: string, assetId: string) => Promise<Amount>;
  readonly linked: Pick<LinkedAccountService, 'get' | 'verify' | 'payoutDetails'>;
};

export interface CashOutOptions {
  /** Who pays out to bank accounts. Null (the default): every cash-out is kept refused `bank.fiat_ramp_socket`. */
  readonly partner?: CashOutPartner | null;
  /** The service secret a receipt's signing key is derived from. Blank, no receipt is made. */
  readonly receiptSecret?: string;
  /** The owner's security lock (W-withdraw-09), asked of identity. Unset: every cash-out the partner could take refuses. */
  readonly securityLock?: SecurityLockPort;
}

const ASSET_RE = /^[A-Z0-9]{1,16}$/;
const LOCK = 'bank.cash-out';
/** The HKDF info label of cash-out receipts: their signing key is derived for them alone. */
const CASH_OUT_RECEIPT_INFO = 'bank.cash-out.receipt.v1';

/** The withdrawal id every ledger post of one cash-out is keyed by. */
export const cashOutWithdrawalId = (id: string) => `cash-out:${id}`;

/** The business key of a TEST stand-in's record that it paid a cash-out out. */
const paidKey = (id: string) => `${cashOutWithdrawalId(id)}:paid`;

export class CashOutService {
  private readonly partner: CashOutPartner | null;
  private readonly securityLock: SecurityLockPort;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'post' | 'getTxByKey'>,
    private readonly reads: Reads,
    private readonly options: CashOutOptions = {},
  ) {
    this.partner = options.partner ?? null;
    this.securityLock = options.securityLock ?? unconfiguredSecurityLock();
  }

  /** The entry checks, then the account, then what stands in the way. Reads only. */
  async quote(userId: string, ask: CashOutAsk): Promise<CashOutQuoteView> {
    const { assetId, amount } = entry(ask);
    const available = await this.reads.available(userId, assetId);
    if (amount > available) {
      throw new BankError(
        `You can cash out up to ${formatAmount(available)} ${assetId}, the balance available now`,
        'bank.cash_out_over_available',
      );
    }
    const account = await this.reads.linked.get(userId, ask.linkedAccountId);
    const price = account.blocker === null ? (this.partner?.price(assetId, amount) ?? null) : null;
    return {
      assetId,
      amount: formatAmount(amount),
      available: formatAmount(available),
      account,
      rail: 'rail.bank',
      fee: price?.fee ?? null,
      receiveAmount: price?.receiveAmount ?? null,
      receiveCurrency: price?.receiveCurrency ?? null,
      blocker: account.blocker ?? (price ? null : 'bank.fiat_ramp_socket'),
      standIn: price ? (this.partner?.label ?? null) : null,
    };
  }

  /** Ask to cash out. Kept refused with its reason, or held and handed to the partner. */
  async start(userId: string, input: CashOutAsk & { requestId: string }): Promise<CashOutRequestView> {
    const { assetId, amount } = entry(input);
    const asked = { assetId, amount, linkedAccountId: input.linkedAccountId.trim().toLowerCase() };
    const prior = await this.row(input.requestId);
    if (prior) return view(await this.drive(same(prior, userId, asked)));
    const quote = await this.quote(userId, { assetId, amount: formatAmount(amount), linkedAccountId: asked.linkedAccountId });
    const taken = quote.blocker === null && this.partner !== null;
    // While the owner's security lock holds, no cash-out starts (W-withdraw-09): asked before anything is written, so a
    // locked account keeps no request and holds nothing. One already taken under this id carries on above.
    if (taken) await assertSecurityLockOpen(this.securityLock, userId, 'a cash-out');
    const rows = await this.sql<RequestRow[]>`
      INSERT INTO bank.cash_out_requests (
        id, user_id, asset_id, amount, linked_account_id, status, refusal_code,
        payout_rail, fee, receive_amount, receive_currency
      ) VALUES (
        ${input.requestId}::uuid, ${userId}, ${assetId}, ${formatAmount(amount)}::numeric, ${asked.linkedAccountId}::uuid,
        ${taken ? 'processing' : 'refused'}, ${taken ? null : quote.blocker},
        ${taken ? this.partner!.rail : null}, ${quote.fee}::numeric, ${quote.receiveAmount}::numeric, ${quote.receiveCurrency}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    const row = rows[0] ?? (await this.row(input.requestId));
    if (!row) throw new BankError('The cash-out request was not stored', 'bank.ramp_conflict');
    return view(await this.drive(same(row, userId, asked)));
  }

  /** The customer's own requests, newest first. */
  async list(userId: string, limit: number): Promise<CashOutRequestView[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT * FROM bank.cash_out_requests WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map(view);
  }

  /**
   * The partner verified one of the customer's linked accounts: it exists and is in their name. Only the partner's
   * signed call reaches this; with no partner it refuses `rail.bank`.
   */
  async verifyAccount(accountId: string): Promise<LinkedAccountView> {
    if (!this.partner) throw new BankError('No banking partner verifies bank accounts in this build', 'rail.bank');
    return this.reads.linked.verify(accountId);
  }

  /** The partner paid it: the hold settles to the partner's rail, once. */
  async complete(id: string): Promise<CashOutRequestView> {
    return this.answer(id, async (row) => {
      if (row.status === 'completed') return row;
      if (row.status !== 'processing' || !row.hold_ledger_tx_id || !row.payout_ref || !row.payout_rail) {
        throw new BankError(`This cash-out is ${row.status} and cannot be marked paid`, 'bank.ramp_conflict');
      }
      // A TEST stand-in records what it paid in its own words first: if the post then fails, the rail shows the gap.
      await this.onRail({
        key: paidKey(row.id),
        direction: 'out',
        assetId: row.asset_id,
        amount: parseAmount(row.amount),
      });
      const settled = await this.ledger.post(recipes.withdrawSettle(this.withdrawal(row)));
      return this.moved(
        row.id,
        'processing',
        this.sql`
        status = 'completed', settle_ledger_tx_id = ${settled.id}, completed_at = now()
      `,
      );
    });
  }

  /** The partner did not pay it: the hold comes back to the available balance, once, with the partner's reason. */
  async fail(id: string, reason: PayoutFailure): Promise<CashOutRequestView> {
    return this.answer(id, async (row) => {
      if (row.status === 'failed' && row.failure_code === reason) return row;
      if (row.status !== 'processing' || !row.payout_rail) {
        throw new BankError(`This cash-out is ${row.status} and cannot be marked failed`, 'bank.ramp_conflict');
      }
      // A TEST stand-in that already recorded this payout as paid cannot also say it failed: the settle is retried instead.
      if (await this.partner!.records?.has(paidKey(row.id))) {
        throw new BankError('The payout stand-in already recorded this cash-out as paid; say paid again', 'bank.ramp_conflict');
      }
      // The ledger, not the row, says whether it was held: a hold it booked whose answer was lost is given back too.
      const reversed = (await this.bookedHold(row)) ? await this.ledger.post(recipes.withdrawReverse(this.withdrawal(row))) : null;
      return this.moved(
        row.id,
        'processing',
        this.sql`
        status = 'failed', failure_code = ${reason}, reverse_ledger_tx_id = ${reversed?.id ?? null}, failed_at = now()
      `,
      );
    });
  }

  /**
   * The receiving bank sent a paid-out amount back, in full or in part: what came back is credited once from the
   * partner's rail. One return per cash-out; the same return again answers the same.
   */
  async returned(id: string, input: { amount: string; assetId: string; reason: PayoutReturn }): Promise<CashOutRequestView> {
    let back: Amount;
    try {
      back = parseAmount(input.amount);
    } catch {
      throw new BankError('The returned amount is not an amount', 'bank.ramp_invalid_amount');
    }
    return this.answer(id, async (row) => {
      if (row.status === 'returned') {
        if (parseAmount(row.returned_amount!) === back && row.failure_code === input.reason) return row;
        throw new BankError('This cash-out already came back on other terms', 'bank.ramp_conflict');
      }
      if (row.status !== 'completed' || !row.payout_rail) {
        throw new BankError(`This cash-out is ${row.status}; only a paid-out one can come back`, 'bank.ramp_conflict');
      }
      // The partner states what came back in the asset that left, at its own rate back: never in what it paid out.
      if (input.assetId.trim().toUpperCase() !== row.asset_id) {
        throw new BankError(`What came back is stated in ${row.asset_id}, the asset that left`, 'bank.ramp_invalid_asset');
      }
      if (back <= 0n || back > parseAmount(row.amount)) {
        throw new BankError('What came back must be above zero and no more than was paid out', 'bank.ramp_invalid_amount');
      }
      await this.onRail({
        key: `${cashOutWithdrawalId(row.id)}:returned`,
        direction: 'in',
        assetId: row.asset_id,
        amount: back,
      });
      const credited = await this.ledger.post(
        recipes.deposit({
          userId: row.user_id,
          assetId: row.asset_id,
          amount: back,
          rail: row.payout_rail,
          railRef: `cash-out-return:${row.id}`,
        }),
      );
      return this.moved(
        row.id,
        'completed',
        this.sql`
        status = 'returned', returned_amount = ${formatAmount(back)}::numeric, failure_code = ${input.reason},
        return_ledger_tx_id = ${credited.id}, returned_at = now()
      `,
      );
    });
  }

  /**
   * Requests left `processing` before their hold or the partner's acceptance, oldest first, driven on again. Each comes
   * back `completed` once the partner has it or it was closed, or `failed` while it is still left (with why).
   */
  async redrive(limit: number): Promise<{ id: string; outcome: 'completed' | 'failed'; reason?: string }[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT * FROM bank.cash_out_requests
       WHERE status = 'processing' AND (hold_ledger_tx_id IS NULL OR payout_ref IS NULL)
         AND created_at < now() - interval '1 minute'
       ORDER BY created_at ASC LIMIT ${limit}
    `;
    const results: { id: string; outcome: 'completed' | 'failed'; reason?: string }[] = [];
    for (const row of rows) {
      try {
        const after = await this.drive(row);
        const left = after.status === 'processing' && !after.payout_ref;
        results.push(left ? { id: row.id, outcome: 'failed', reason: 'bank.cash_out_partner_gone' } : { id: row.id, outcome: 'completed' });
      } catch (err) {
        // One that cannot be driven now does not stop the others: it is picked up on the next pass.
        results.push({ id: row.id, outcome: 'failed', reason: err instanceof BankError ? err.code : 'bank.cash_out_redrive_failed' });
      }
    }
    return results;
  }

  /**
   * The signed receipt of a cash-out that was paid (BK-xfer-08): what left, to which account (masked), the partner's
   * fee and what arrived, the payout reference and the ledger transaction id, with the SHA-256 of the text and an
   * HMAC-SHA256 signature over it under a key derived from the service secret for cash-out receipts alone. It says where
   * the cash-out stands, and once part or all of it came back, how much and why. The same cash-out in the same state
   * always gives the same bytes.
   */
  async receipt(userId: string, id: string): Promise<CashOutReceipt> {
    const row = await this.row(id);
    if (!row || row.user_id !== userId) throw new BankError('No cash-out with this id', 'bank.cash_out_not_found');
    if ((row.status !== 'completed' && row.status !== 'returned') || !row.settle_ledger_tx_id || !row.completed_at) {
      throw new BankError('This cash-out was not paid out, so it has no receipt', 'bank.cash_out_receipt_not_ready');
    }
    const secret = this.options.receiptSecret?.trim();
    if (!secret) throw new BankError('No receipt signing key is set', 'bank.cash_out_receipt_signing_unset');
    const account = await this.reads.linked.payoutDetails(userId, row.linked_account_id);
    const sent = parseAmount(row.amount);
    const back = row.status === 'returned' ? parseAmount(row.returned_amount!) : null;
    const text = [
      'INTAFACED receipt: cash out',
      `Cash out: ${row.id}`,
      `Created (UTC): ${row.created_at.toISOString()}`,
      `Paid out (UTC): ${row.completed_at.toISOString()}`,
      `Status: ${row.status}`,
      `Sent: ${formatAmount(sent)} ${row.asset_id}`,
      `Fee: ${row.fee === null ? '' : formatAmount(parseAmount(row.fee))} ${oneLine(row.receive_currency)}`,
      `Arrives: ${row.receive_amount === null ? '' : formatAmount(parseAmount(row.receive_amount))} ${oneLine(row.receive_currency)}`,
      `To: ${oneLine(account.holderName)} · ${oneLine(account.ibanMasked)}`,
      `Payout reference: ${oneLine(row.payout_ref)}`,
      `Ledger transaction: ${row.settle_ledger_tx_id}`,
      ...(back === null || !row.returned_at
        ? []
        : [
            `Came back (UTC): ${row.returned_at.toISOString()}`,
            `Came back: ${formatAmount(back)} ${row.asset_id} (${oneLine(row.failure_code)})`,
            `Stays paid out: ${formatAmount(sent - back)} ${row.asset_id}`,
            `Return ledger transaction: ${oneLine(row.return_ledger_tx_id)}`,
          ]),
      '',
    ].join('\n');
    return {
      fileName: `receipt-${row.id}.txt`,
      text,
      ledgerTxId: row.settle_ledger_tx_id,
      ...signReceipt(text, secret, CASH_OUT_RECEIPT_INFO),
    };
  }

  /**
   * Take a `processing` request as far as it goes here: its hold, then the partner's acceptance. Each step is keyed by
   * the request, so driving it again posts nothing twice. Refused and answered requests come back unchanged.
   */
  private async drive(row: RequestRow): Promise<RequestRow> {
    if (row.status !== 'processing' || (row.hold_ledger_tx_id && row.payout_ref)) return row;
    return withSessionAdvisoryLock(this.sql, LOCK, row.id, async () => {
      let now = (await this.row(row.id))!;
      if (now.status !== 'processing') return now;
      // The owner's self-freeze (I-account-lifecycle-08) is their emergency stop: while it is open nothing new is held
      // and the partner is not asked to pay, a request taken before it included (the re-drive job and a replay alike).
      // A hold already booked is only stamped, and stays held until they lift it. Asked once, before either step.
      let frozenChecked = false;
      const assertNotSelfFrozen = async () => {
        if (frozenChecked) return;
        const hold = await this.securityLock.read(now.user_id);
        if (hold.selfFrozen) assertHoldsOpen(hold, 'a cash-out');
        frozenChecked = true;
      };
      if (!now.hold_ledger_tx_id) {
        const booked = await this.bookedHold(now);
        if (booked) {
          // Held before, and the answer was lost: stamp that hold, never post another.
          now = await this.moved(now.id, 'processing', this.sql`hold_ledger_tx_id = ${booked}`);
        } else if (!this.partner || this.partner.rail !== now.payout_rail) {
          // No partner here pays it: nothing is held for a payout nobody would be asked to make. It stays processing,
          // not refused, because a hold posted before and still on its way may yet land, and only a processing request
          // can find that hold again (on the next drive) or give it back (the partner's failed answer).
          return now;
        }
      }
      if (!now.hold_ledger_tx_id) {
        await assertNotSelfFrozen();
        let holdId: string;
        try {
          holdId = (await this.ledger.post(recipes.withdrawHold(this.withdrawal(now)))).id;
        } catch (err) {
          if (!(err instanceof InsufficientFundsError)) throw err;
          // The balance moved since the quote: kept refused, nothing held.
          return this.moved(
            now.id,
            'processing',
            this.sql`
            status = 'refused', refusal_code = 'bank.cash_out_over_available', payout_rail = NULL
          `,
          );
        }
        now = await this.moved(now.id, 'processing', this.sql`hold_ledger_tx_id = ${holdId}`);
      }
      if (!now.payout_ref) {
        if (!this.partner || this.partner.rail !== now.payout_rail) {
          // The partner that priced it is gone after the hold: the hold waits, visible, for that partner's answer.
          return now;
        }
        await assertNotSelfFrozen();
        const { payoutRef } = await this.partner.pay({
          cashOutId: now.id,
          assetId: now.asset_id,
          amount: formatAmount(parseAmount(now.amount)),
        });
        now = await this.moved(now.id, 'processing', this.sql`payout_ref = ${payoutRef}`);
      }
      return now;
    });
  }

  /** One partner answer on one request, under the request's lock. */
  private async answer(id: string, act: (row: RequestRow) => Promise<RequestRow>): Promise<CashOutRequestView> {
    return withSessionAdvisoryLock(this.sql, LOCK, id, async () => {
      const row = await this.row(id);
      if (!row) throw new BankError('No cash-out with this id', 'bank.cash_out_not_found');
      // Only the partner that took it answers for it: with none here, or another one, nothing moves.
      if (!this.partner || row.payout_rail !== this.partner.rail) {
        throw new BankError('No banking partner here answers for this cash-out', 'rail.bank');
      }
      return view(await act(row));
    });
  }

  /** A TEST stand-in's own record of a movement on its rail; one the rail already contradicts is a conflict, nothing posted. */
  private async onRail(movement: RailMovement): Promise<void> {
    try {
      await this.partner!.records?.record(movement);
    } catch (err) {
      if (err instanceof RailRecordError && err.conflict) throw new BankError(err.message, 'bank.ramp_conflict');
      throw err;
    }
  }

  /** Update one request that is still in `from`, returning the row as it now is. Anything else is a conflict. */
  private async moved(id: string, from: CashOutStatus, set: PendingQuery<Row[]>): Promise<RequestRow> {
    const rows = await this.sql<RequestRow[]>`
      UPDATE bank.cash_out_requests SET ${set} WHERE id = ${id}::uuid AND status = ${from} RETURNING *
    `;
    if (!rows[0]) throw new BankError('The cash-out changed while it was being answered', 'bank.ramp_conflict');
    return rows[0];
  }

  /** The hold's ledger transaction: as stamped on the row, else as the ledger booked it under the request's key, else null. */
  private async bookedHold(row: RequestRow): Promise<string | null> {
    if (row.hold_ledger_tx_id) return row.hold_ledger_tx_id;
    if (!row.payout_rail) return null;
    return (await this.ledger.getTxByKey(recipes.withdrawHold(this.withdrawal(row)).idempotencyKey))?.id ?? null;
  }

  private withdrawal(row: RequestRow) {
    return {
      userId: row.user_id,
      assetId: row.asset_id,
      amount: parseAmount(row.amount),
      rail: row.payout_rail!,
      withdrawalId: cashOutWithdrawalId(row.id),
    };
  }

  private async row(id: string): Promise<RequestRow | undefined> {
    const rows = await this.sql<RequestRow[]>`SELECT * FROM bank.cash_out_requests WHERE id = ${id}::uuid`;
    return rows[0];
  }
}

/** The amount above zero and the asset as a ledger symbol. */
function entry(ask: { assetId: string; amount: string }): { assetId: string; amount: Amount } {
  const assetId = ask.assetId.trim().toUpperCase();
  if (!ASSET_RE.test(assetId)) throw new BankError('Choose the currency to cash out', 'bank.ramp_invalid_asset');
  let amount: Amount;
  try {
    amount = parseAmount(ask.amount.trim());
  } catch {
    throw new BankError('Enter an amount with up to 18 decimals', 'bank.ramp_invalid_amount');
  }
  if (amount <= 0n) throw new BankError('The amount to cash out must be above zero', 'bank.ramp_invalid_amount');
  return { assetId, amount };
}

const decimalOrNull = (value: string | null) => (value === null ? null : formatAmount(parseAmount(value)));
const isoOrNull = (value: Date | null) => (value === null ? null : value.toISOString());

function view(row: RequestRow): CashOutRequestView {
  return {
    requestId: row.id,
    assetId: row.asset_id,
    amount: formatAmount(parseAmount(row.amount)),
    linkedAccountId: row.linked_account_id,
    rail: row.rail,
    status: row.status,
    refusalCode: row.refusal_code,
    fee: decimalOrNull(row.fee),
    receiveAmount: decimalOrNull(row.receive_amount),
    receiveCurrency: row.receive_currency,
    payoutRef: row.payout_ref,
    ledgerTxId: row.settle_ledger_tx_id,
    failureCode: row.failure_code,
    returnedAmount: decimalOrNull(row.returned_amount),
    remainsPaidOut:
      row.status === 'completed'
        ? formatAmount(parseAmount(row.amount))
        : row.status === 'returned'
          ? formatAmount(parseAmount(row.amount) - parseAmount(row.returned_amount!))
          : null,
    createdAt: row.created_at.toISOString(),
    completedAt: isoOrNull(row.completed_at),
    failedAt: isoOrNull(row.failed_at),
    returnedAt: isoOrNull(row.returned_at),
  };
}

/** The stored request, if it is this customer's and was asked on the same terms. Anything else is a conflict. */
function same(row: RequestRow, userId: string, asked: { assetId: string; amount: Amount; linkedAccountId: string }): RequestRow {
  const matches =
    row.user_id === userId &&
    row.asset_id === asked.assetId &&
    parseAmount(row.amount) === asked.amount &&
    row.linked_account_id === asked.linkedAccountId;
  if (!matches) throw new BankError('This request id is already used on other terms', 'bank.ramp_conflict');
  return row;
}
