/**
 * CASH OUT (BK-ord-01, J-bank-03): turn part of the balance into money in one of the customer's linked bank accounts.
 *
 * The customer enters an amount and picks a linked account. The entry checks come first, in this order: an amount above
 * zero, no more than the available balance (read from the ledger, never from a copy), and an account of theirs that is
 * still linked. The quote then says what stands in the way, first reason first:
 * - the account is not verified (`bank.linked_account_unverified`): only a banking partner can verify it;
 * - its cooling-off has no published length (`bank.offramp_cooling_unset`) or has not ended (`bank.offramp_cooling_active`);
 * - no banking partner pays out to bank accounts (`bank.fiat_ramp_socket`, rail `rail.bank`).
 * There is no fee or receive amount to show until a partner prices one, and none is invented.
 *
 * Asking to cash out (behind the step-up scope) is kept whatever the answer. In this build every request is kept
 * `refused` with the first blocker, and nothing is held or posted: money would leave only through the ledger's withdraw
 * recipes once a partner pays out. The request id is the customer's business key for one ask: the same id on the same
 * terms is the same request, and on other terms, or from someone else, is `bank.ramp_conflict`.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError, type BankErrorCode } from '../errors.js';
import type { LinkedAccountService, LinkedAccountView } from '../linked-accounts/linked-accounts.js';

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
  /** The partner's fee and the amount that arrives. Null while no partner prices a cash-out. */
  readonly fee: string | null;
  readonly receiveAmount: string | null;
  /** What stands in the way, first reason first. In this build there is always one: at least the missing partner. */
  readonly blocker: BankErrorCode;
}

export interface CashOutRequestView {
  readonly requestId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly linkedAccountId: string;
  readonly rail: 'rail.bank';
  readonly status: 'refused';
  readonly refusalCode: string;
  readonly createdAt: string;
}

interface RequestRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  linked_account_id: string;
  rail: 'rail.bank';
  status: 'refused';
  refusal_code: string;
  created_at: Date;
}

type Reads = {
  readonly available: (userId: string, assetId: string) => Promise<Amount>;
  readonly linked: Pick<LinkedAccountService, 'get'>;
};

const ASSET_RE = /^[A-Z0-9]{1,16}$/;

export class CashOutService {
  constructor(
    private readonly sql: Sql,
    private readonly reads: Reads,
  ) {}

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
    return {
      assetId,
      amount: formatAmount(amount),
      available: formatAmount(available),
      account,
      rail: 'rail.bank',
      fee: null,
      receiveAmount: null,
      // No partner pays out to bank accounts in this build, so even a usable account ends on the rail.
      blocker: account.blocker ?? 'bank.fiat_ramp_socket',
    };
  }

  /** Ask to cash out. Kept with the reason it cannot go ahead; nothing is held or posted. */
  async start(userId: string, input: CashOutAsk & { requestId: string }): Promise<CashOutRequestView> {
    const { assetId, amount } = entry(input);
    const asked = { assetId, amount, linkedAccountId: input.linkedAccountId.trim().toLowerCase() };
    const prior = await this.row(input.requestId);
    if (prior) return view(same(prior, userId, asked));
    const quote = await this.quote(userId, { assetId, amount: formatAmount(amount), linkedAccountId: asked.linkedAccountId });
    const rows = await this.sql<RequestRow[]>`
      INSERT INTO bank.cash_out_requests (id, user_id, asset_id, amount, linked_account_id, status, refusal_code)
      VALUES (
        ${input.requestId}::uuid, ${userId}, ${assetId}, ${formatAmount(amount)}::numeric, ${asked.linkedAccountId}::uuid,
        'refused', ${quote.blocker}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    const row = rows[0] ?? (await this.row(input.requestId));
    if (!row) throw new BankError('The cash-out request was not stored', 'bank.ramp_conflict');
    return view(same(row, userId, asked));
  }

  /** The customer's own requests, newest first. */
  async list(userId: string, limit: number): Promise<CashOutRequestView[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT * FROM bank.cash_out_requests WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map(view);
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

function view(row: RequestRow): CashOutRequestView {
  return {
    requestId: row.id,
    assetId: row.asset_id,
    amount: formatAmount(parseAmount(row.amount)),
    linkedAccountId: row.linked_account_id,
    rail: row.rail,
    status: row.status,
    refusalCode: row.refusal_code,
    createdAt: row.created_at.toISOString(),
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
