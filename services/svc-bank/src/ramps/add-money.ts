/**
 * ADD MONEY (BK-xfer-04, BK-xfer-05, J-bank-02): the ways to pay in, and the customer's add-money requests.
 *
 * Every way to pay comes with its quote from the rate source (pay amount, fee, rate, delivery estimate) or with the reason
 * there is none. Nothing here prices a spread, assumes a zero fee or estimates a delivery time: a blank is a blank.
 *
 * A request is kept whatever the rail answers. With no partner or rate source it is refused with the rail it needed
 * (`rail.bank` for bank transfer and pay by bank, `rail.card` for card and wallet) and the refusal code. Otherwise it is
 * written as `opening`, with the quote it is asked on, before the partner is called, and then marked `opened` with the
 * partner's instruction (a hosted page to pay on, or bank-transfer instructions). If the call fails in between, the
 * request stays `opening` in the customer's list, and asking again with the same id picks up the instruction the partner
 * already opened (the on-ramp id is the request id) rather than opening a second. Opening posts nothing to the ledger:
 * money reaches the balance only when the rail pays and the deposit recipe credits it.
 *
 * PAID (J-bank-02 #3, #5). An opened request moves on as the partner says: `pending` once the payer approved the payment
 * on the partner's page (`approved`), and `credited` once the partner says the money arrived (`paid`). Paid is checked
 * against the payment the partner opened (the same pay amount and currency, or `bank.onramp_paid_mismatch` and nothing
 * is credited), and the credit is the quote's receive amount exactly, through the deposit recipe from the partner's rail
 * boundary under the business key `deposit:<rail>:add-money:<request id>`. If this crashes after the post and before the
 * row says credited, the partner's next "paid" posts the same key, which the ledger answers with the transaction it
 * already booked, and the row catches up: the money is credited once and never stranded. With no partner wired, both
 * refuse `bank.fiat_ramp_socket` and nothing moves.
 *
 * The request id is the customer's business key: asking again with the same id and the same terms is the same request,
 * and with other terms is `bank.ramp_conflict`. A quote the customer accepted must be theirs and on the request's own
 * terms; one that has already expired is refused (`bank.onramp_quote_expired`) and keeps nothing.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { BankError, type BankErrorCode } from '../errors.js';
import type { OnrampMethod } from './customer-ports.js';
import type { CustomerOnrampView, OnrampQuoteView } from './customer-ramps.js';
import type { OnrampPartner } from './payin-sim.js';
import type { RampService } from './ramp-service.js';

/** The order the chooser shows the ways to pay. */
export const ADD_MONEY_METHODS = ['bank_transfer', 'pay_by_bank', 'card', 'wallet_pay'] as const satisfies readonly OnrampMethod[];

export type AddMoneyRail = 'rail.bank' | 'rail.card';

export function railFor(method: OnrampMethod): AddMoneyRail {
  return method === 'bank_transfer' || method === 'pay_by_bank' ? 'rail.bank' : 'rail.card';
}

/** The refusals that mean "no partner, rail or rate source is connected for this way to pay". */
const RAIL_REFUSALS: ReadonlySet<BankErrorCode> = new Set<BankErrorCode>([
  'bank.fiat_ramp_socket',
  'bank.fiat_ramp_no_pay_adapter',
  'bank.no_fiat_rail',
  'bank.onramp_rate_unset',
]);

const railRefusal = (err: unknown): BankErrorCode | null => (err instanceof BankError && RAIL_REFUSALS.has(err.code) ? err.code : null);

/**
 * The answers that close a request already kept as `opening`: a rail refusal, or its quote running out before the partner
 * opened anything. Anything else (a partner that answered with a broken instruction, a network fault) leaves it opening.
 */
const finalRefusal = (err: unknown): BankErrorCode | null =>
  railRefusal(err) ?? (err instanceof BankError && err.code === 'bank.onramp_quote_expired' ? err.code : null);

export type AddMoneyStatus = 'opening' | 'refused' | 'opened' | 'pending' | 'credited';

export interface AddMoneyMethodView {
  readonly method: OnrampMethod;
  readonly rail: AddMoneyRail;
  /** The rate source's quote for this way to pay, or null with the reason in `blocker`. */
  readonly quote: OnrampQuoteView | null;
  readonly blocker: BankErrorCode | null;
  /** The TEST stand-in's label when the quote is the local stack's TEST rate stand-in, or null. */
  readonly standIn: string | null;
  /** The TEST pay-in stand-in's label when the local stack's TEST partner opens this way to pay, or null. */
  readonly payStandIn: string | null;
}

export interface AddMoneyRequestView {
  readonly requestId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly method: OnrampMethod;
  readonly country: string;
  readonly rail: AddMoneyRail;
  readonly status: AddMoneyStatus;
  readonly refusalCode: string | null;
  /** The partner's instruction once the request opened: where to pay, or the bank details to pay to. */
  readonly onramp: CustomerOnrampView | null;
  readonly createdAt: string;
  /** When the partner opened the payment, the payer approved it, and the money was credited; null until each happened. */
  readonly openedAt: string | null;
  readonly pendingAt: string | null;
  readonly creditedAt: string | null;
  /** What the ledger credited: the quote's receive amount, in `assetId`. Null until credited. */
  readonly creditedAmount: string | null;
}

interface RequestRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  method: OnrampMethod;
  country: string;
  rail: AddMoneyRail;
  status: AddMoneyStatus;
  refusal_code: string | null;
  quote_id: string | null;
  onramp_id: string | null;
  created_at: Date;
  opened_at: Date | null;
  pending_at: Date | null;
  credited_at: Date | null;
  credited_amount: string | null;
  ledger_tx_id: string | null;
}

export interface AddMoneyInput {
  readonly requestId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly method: OnrampMethod;
  readonly country: string;
  /** A quote the customer already accepted. Without one the request asks the rate source itself. */
  readonly quoteId?: string | undefined;
}

type Kept = { status: 'opening'; quoteId: string } | { status: 'refused'; code: BankErrorCode };

export class AddMoneyService {
  constructor(
    private readonly sql: Sql,
    private readonly ramps: Pick<
      RampService,
      'onrampQuote' | 'onrampQuoteOf' | 'onrampCreate' | 'customerOnrampsByIds' | 'onrampStandInFor'
    >,
    /** Who credits a paid request: the ledger, and the partner that opened it. No partner refuses both partner calls. */
    private readonly credit: { readonly ledger: Pick<LedgerClient, 'post'>; readonly partner: OnrampPartner | null } | null = null,
  ) {}

  /** Each way to pay with its quote, or the reason there is none. A bad amount, asset or country refuses the whole read. */
  async methods(userId: string, input: { assetId: string; amount: string; country: string }): Promise<AddMoneyMethodView[]> {
    return Promise.all(
      ADD_MONEY_METHODS.map(async (method): Promise<AddMoneyMethodView> => {
        try {
          const quote = await this.ramps.onrampQuote({ userId, ...input, method });
          // The TEST label goes only on a price the stand-in gave, never on a blank.
          const standIn = this.ramps.onrampStandInFor({ assetId: input.assetId, method, country: input.country });
          // The TEST partner's label goes only on a priced way to pay it would open.
          const partner = this.credit?.partner;
          const payStandIn = partner?.covers(method) ? partner.label : null;
          return { method, rail: railFor(method), quote, blocker: null, standIn, payStandIn };
        } catch (err) {
          const code = railRefusal(err);
          if (code === null) throw err;
          return { method, rail: railFor(method), quote: null, blocker: code, standIn: null, payStandIn: null };
        }
      }),
    );
  }

  /** Ask for money to be added. Kept whether the rail opens it or refuses it; posts nothing either way. */
  async start(userId: string, input: AddMoneyInput): Promise<AddMoneyRequestView> {
    const parsed = parseAmount(input.amount);
    if (parsed <= 0n) throw new BankError('The amount to add must be above zero', 'bank.validation_failed');
    const asked = {
      ...input,
      amount: formatAmount(parsed),
      country: input.country.trim().toUpperCase(),
      // Postgres hands uuids back in lower case; compare the same way.
      quoteId: input.quoteId?.toLowerCase(),
    };
    const prior = await this.row(input.requestId);
    if (prior) return this.settle(same(prior, userId, asked));

    let kept: Kept;
    try {
      const quoteId = asked.quoteId
        ? await this.accepted(userId, asked.quoteId, asked)
        : (
            await this.ramps.onrampQuote({
              userId,
              assetId: asked.assetId,
              amount: asked.amount,
              method: asked.method,
              country: asked.country,
            })
          ).quoteId;
      kept = { status: 'opening', quoteId };
    } catch (err) {
      const code = railRefusal(err);
      if (code === null) throw err;
      kept = { status: 'refused', code };
    }
    return this.settle(await this.keep(userId, asked, kept));
  }

  /** The customer's own requests, newest first, each with its instruction read in one go. */
  async list(userId: string, limit: number): Promise<AddMoneyRequestView[]> {
    const rows = await this.sql<RequestRow[]>`
      SELECT * FROM bank.add_money_requests WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    const onramps = await this.ramps.customerOnrampsByIds(
      userId,
      rows.flatMap((row) => (row.onramp_id ? [row.onramp_id] : [])),
    );
    return rows.map((row) => view(row, onramps));
  }

  /** One of the customer's own requests, for the tracker. Someone else's, or none, is `bank.add_money_request_missing`. */
  async request(userId: string, requestId: string): Promise<AddMoneyRequestView> {
    const row = await this.row(requestId);
    if (!row || row.user_id !== userId) throw new BankError('No add-money request of yours has that id', 'bank.add_money_request_missing');
    return this.one(row);
  }

  /**
   * The partner's page: the payer approved the payment there. An opened request becomes `pending`; one already pending or
   * credited answers as it stands. Answers where the partner sends the payer back. Moves no money.
   */
  async approved(onrampId: string): Promise<{ request: AddMoneyRequestView; returnUrl: string }> {
    const { partner } = this.wired();
    const row = await this.partnerRow(partner, onrampId);
    if (row.status === 'opened') {
      await this.sql`
        UPDATE bank.add_money_requests SET status = 'pending', pending_at = now()
         WHERE id = ${row.id}::uuid AND status = 'opened'
      `;
    }
    return { request: await this.one((await this.row(row.id)) ?? row), returnUrl: partner.returnUrl(row.id) };
  }

  /** The partner's own read of a payment it opened, for its page. */
  async opened(onrampId: string): Promise<{ request: AddMoneyRequestView; returnUrl: string }> {
    const { partner } = this.wired();
    const row = await this.partnerRow(partner, onrampId);
    return { request: await this.one(row), returnUrl: partner.returnUrl(row.id) };
  }

  /**
   * The partner says the money arrived: credit the quote's receive amount once, through the deposit recipe. What it says
   * was paid must be the payment it opened. A request already credited answers as it stands, and credits nothing again.
   */
  async paid(input: { requestId: string; paidAmount: string; payCurrency: string }): Promise<AddMoneyRequestView> {
    const { ledger, partner } = this.wired();
    const row = await this.partnerRow(partner, input.requestId);
    const view = await this.one(row);
    const onramp = view.onramp;
    if (!onramp) throw new BankError('This request has no payment the partner opened', 'bank.ramp_conflict');
    let paid: bigint;
    try {
      paid = parseAmount(input.paidAmount);
    } catch {
      throw new BankError('The partner named a paid amount that is not an exact decimal', 'bank.onramp_paid_mismatch');
    }
    if (paid !== parseAmount(onramp.payAmount) || input.payCurrency.trim().toUpperCase() !== onramp.payCurrency) {
      throw new BankError(
        `The partner says ${input.paidAmount} ${input.payCurrency} was paid; the payment it opened is ${onramp.payAmount} ${onramp.payCurrency}. Nothing was credited`,
        'bank.onramp_paid_mismatch',
      );
    }
    if (row.status === 'credited') return view;
    // The receive amount is the quote's, which the request was asked on; the two never differ, and if they did nothing moves.
    const receive = parseAmount(onramp.amount);
    if (receive !== parseAmount(row.amount) || onramp.assetId !== row.asset_id) {
      throw new BankError('The opened payment is not on the request’s own terms', 'bank.ramp_conflict');
    }
    const posted = await ledger.post(
      recipes.deposit({
        userId: row.user_id,
        assetId: row.asset_id,
        amount: receive,
        rail: partner.rail,
        railRef: `add-money:${row.id}`,
      }),
    );
    const rows = await this.sql<RequestRow[]>`
      UPDATE bank.add_money_requests
         SET status = 'credited', credited_at = now(), credited_amount = ${formatAmount(receive)}::numeric,
             ledger_tx_id = ${posted.id}
       WHERE id = ${row.id}::uuid AND status IN ('opened', 'pending')
      RETURNING *
    `;
    return this.one(rows[0] ?? (await this.row(row.id)) ?? row);
  }

  private wired(): { ledger: Pick<LedgerClient, 'post'>; partner: OnrampPartner } {
    const partner = this.credit?.partner;
    if (!this.credit || !partner) {
      throw new BankError('No pay-in partner is connected (socket.psp-partners), so no payment is approved or credited', 'bank.fiat_ramp_socket');
    }
    return { ledger: this.credit.ledger, partner };
  }

  /** A request this partner opened, past opening and not refused. */
  private async partnerRow(partner: OnrampPartner, requestId: string): Promise<RequestRow> {
    const row = await this.row(requestId);
    if (!row) throw new BankError('No add-money request has that id', 'bank.add_money_request_missing');
    if (row.status === 'opening' || row.status === 'refused' || !row.onramp_id) {
      throw new BankError(`This request is ${row.status}; no payment was opened for it`, 'bank.ramp_conflict');
    }
    const onramp = (await this.ramps.customerOnrampsByIds(row.user_id, [row.onramp_id])).get(row.onramp_id);
    if (!onramp || onramp.partnerRail !== partner.rail) {
      throw new BankError('This payment was not opened by this partner', 'bank.ramp_conflict');
    }
    return row;
  }

  /** The accepted quote, if it is the caller's, on the request's own terms and still live. */
  private async accepted(userId: string, quoteId: string, asked: AddMoneyInput): Promise<string> {
    const quote = await this.ramps.onrampQuoteOf(userId, quoteId);
    const matches =
      quote.assetId === asked.assetId &&
      parseAmount(quote.amount) === parseAmount(asked.amount) &&
      quote.method === asked.method &&
      quote.country === asked.country;
    if (!matches) throw new BankError('The quote was given on other terms than this request', 'bank.ramp_conflict');
    if (Date.parse(quote.expiresAt) <= Date.now()) throw new BankError('On-ramp quote has expired', 'bank.onramp_quote_expired');
    return quote.quoteId;
  }

  /** Write the request once. A request already written under this id must be this customer's, on the same terms. */
  private async keep(userId: string, asked: AddMoneyInput, kept: Kept): Promise<RequestRow> {
    const rows = await this.sql<RequestRow[]>`
      INSERT INTO bank.add_money_requests (id, user_id, asset_id, amount, method, country, rail, status, refusal_code, quote_id)
      VALUES (
        ${asked.requestId}::uuid, ${userId}, ${asked.assetId}, ${asked.amount}::numeric, ${asked.method}, ${asked.country},
        ${railFor(asked.method)}, ${kept.status},
        ${kept.status === 'refused' ? kept.code : null},
        ${kept.status === 'opening' ? kept.quoteId : null}::uuid
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    const row = rows[0] ?? (await this.row(asked.requestId));
    if (!row) throw new BankError('The add-money request was not stored', 'bank.ramp_conflict');
    return same(row, userId, asked);
  }

  /** Ask the partner for a request still opening, and record its answer. The partner sees the request id as the on-ramp id. */
  private async settle(row: RequestRow): Promise<AddMoneyRequestView> {
    if (row.status !== 'opening' || !row.quote_id) return this.one(row);
    let next: { status: 'opened'; onrampId: string } | { status: 'refused'; code: BankErrorCode };
    try {
      const onramp = await this.ramps.onrampCreate({ userId: row.user_id, onrampId: row.id, quoteId: row.quote_id, method: row.method });
      next = { status: 'opened', onrampId: onramp.onrampId };
    } catch (err) {
      const code = finalRefusal(err);
      // Anything else leaves the request opening, in the list, for the same id to pick up.
      if (code === null) throw err;
      next = { status: 'refused', code };
    }
    const rows = await this.sql<RequestRow[]>`
      UPDATE bank.add_money_requests
         SET status = ${next.status},
             refusal_code = ${next.status === 'refused' ? next.code : null},
             onramp_id = ${next.status === 'opened' ? next.onrampId : null}::uuid,
             opened_at = ${next.status === 'opened' ? new Date() : null}
       WHERE id = ${row.id}::uuid AND status = 'opening'
      RETURNING *
    `;
    return this.one(rows[0] ?? (await this.row(row.id)) ?? row);
  }

  private async one(row: RequestRow): Promise<AddMoneyRequestView> {
    return view(row, await this.ramps.customerOnrampsByIds(row.user_id, row.onramp_id ? [row.onramp_id] : []));
  }

  private async row(id: string): Promise<RequestRow | undefined> {
    const rows = await this.sql<RequestRow[]>`SELECT * FROM bank.add_money_requests WHERE id = ${id}::uuid`;
    return rows[0];
  }
}

function view(row: RequestRow, onramps: ReadonlyMap<string, CustomerOnrampView>): AddMoneyRequestView {
  return {
    requestId: row.id,
    assetId: row.asset_id,
    amount: formatAmount(parseAmount(row.amount)),
    method: row.method,
    country: row.country,
    rail: row.rail,
    status: row.status,
    refusalCode: row.refusal_code,
    onramp: (row.onramp_id && onramps.get(row.onramp_id)) || null,
    createdAt: row.created_at.toISOString(),
    openedAt: row.opened_at?.toISOString() ?? null,
    pendingAt: row.pending_at?.toISOString() ?? null,
    creditedAt: row.credited_at?.toISOString() ?? null,
    creditedAmount: row.credited_amount === null ? null : formatAmount(parseAmount(row.credited_amount)),
  };
}

/** The stored request, if it is this customer's and was asked on the same terms. Anything else is a conflict. */
function same(row: RequestRow, userId: string, asked: AddMoneyInput): RequestRow {
  const matches =
    row.user_id === userId &&
    row.asset_id === asked.assetId &&
    parseAmount(row.amount) === parseAmount(asked.amount) &&
    row.method === asked.method &&
    row.country === asked.country &&
    (asked.quoteId === undefined || row.quote_id === null || row.quote_id === asked.quoteId);
  if (!matches) throw new BankError('This request id is already used on other terms', 'bank.ramp_conflict');
  return row;
}
