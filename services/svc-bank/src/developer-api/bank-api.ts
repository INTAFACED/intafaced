import { createHmac, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  NO_PARTNER_BANK_CODE,
  partnerAccountFor,
  partnerCustodyMismatch,
  partnerFigure,
  type PartnerAccountRef,
  type PartnerBank,
  type PartnerCustody,
  type PartnerPayment,
  type PartnerPaymentMethod,
  type PartnerPaymentRecipient,
} from '../partner/partner-bank.js';
import type { TestPartner } from '../partner/test-partner.js';
import { lockEnd, type SpaceRecord, type SpaceService } from '../spaces/space-service.js';
import type { SharedPotService } from '../spaces/shared-pots.js';
import { pinnedPost, type WebhookTransport } from './webhook-pinned-post.js';
import {
  assertPublicWebhookUrl,
  publicDnsResolver,
  resolvePublicAddresses,
  systemResolver,
  type WebhookResolver,
} from './webhook-url-guard.js';

/**
 * THE BANK API (J-bank-24; BK-bdev-01, BK-bdev-02): what a person's own program does with their bank money through an API
 * key they approved with a second factor (identity's `developerKeys.create`; the key holds `bank:read` and `bank:write`).
 *
 * The money is the partner bank's (OWNER 226). So:
 *   - an account's figure is the partner's, with its time; a figure it has not reported is "not known", never 0;
 *   - a move between the person's own accounts is made on the partner's quote, as ONE partner move under the business key
 *     `bank.api.move:<user>:<dedupe id>`, written as an intent row first: a lost answer keeps the row, and a retry under the
 *     same dedupe id asks again under the same key, on the same stored terms, so it is made once;
 *   - a payment out (instant or ACH) is the partner's, over its rail, under `pay:<user>:<idempotency key>`, written as an
 *     intent row before the partner is asked; with no rail it is kept refused with `rail.bank`;
 *   - each change of a payment's state the partner reports is kept once per (payment, version) and delivered to each of the
 *     person's webhook endpoints once, signed, carrying the previous and current state; a replayed report adds nothing.
 * The ledger posts nothing for any of it, and the API reaches nothing the app does not: a locked pot refuses
 * `bank.space_locked`, only a shared pot's owner takes money out of it, and the posting freeze and partner stop guard every
 * partner move (`freezeGuardedCustody`, `stopGuardedCustody`).
 */

export const API_ACCOUNT_TYPES = ['standard', 'savings', 'joint'] as const;
export type ApiAccountType = (typeof API_ACCOUNT_TYPES)[number];

export interface ApiAccount {
  readonly id: string;
  readonly type: ApiAccountType;
  readonly name: string;
  readonly assetId: string;
  /** Whose account it is: a joint account may be another person's pot shared with the caller. */
  readonly owner: 'self' | 'other';
  readonly heldAt: string;
  /** The partner's figure, a decimal string, or null when it has not reported one ("not known", never 0). */
  readonly balance: string | null;
  readonly figure: 'known' | 'stale' | 'unknown';
  readonly asOf: Date | null;
  /** What left this account today (UTC), from the partner's own record; null when the record read does not reach back to midnight. */
  readonly spendToday: string | null;
  /** When the pot's lock ends, or null when it is not locked. A locked pot refuses every move out (`bank.space_locked`). */
  readonly lockedUntil: Date | null;
}

export interface ApiMoveQuote {
  readonly quoteId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly fee: string | null;
  readonly receives: string | null;
  readonly heldAt: string;
  readonly quotedAt: Date;
  readonly validUntil: Date;
}

export interface ApiMove {
  readonly dedupeId: string;
  readonly quote: ApiMoveQuote;
  readonly state: 'pending' | 'completed';
  readonly partnerMoveId: string | null;
  readonly completedAt: Date | null;
}

export type ApiPaymentState = 'asked' | 'refused' | 'pending' | 'completed' | 'cancelled' | 'reversed';

export interface ApiPayment {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly fromAccountId: string;
  readonly assetId: string;
  readonly method: PartnerPaymentMethod;
  readonly recipient: PartnerPaymentRecipient;
  readonly amount: string;
  readonly state: ApiPaymentState;
  readonly refusalCode: string | null;
  readonly version: number;
  readonly heldAt: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ApiWebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly createdAt: Date;
  /** The signing secret, shown once: on the create that made the endpoint, null on every other read. */
  readonly secret: string | null;
}

export interface ApiDelivery {
  readonly eventId: string;
  readonly endpointId: string;
  readonly paymentId: string;
  readonly previous: string | null;
  readonly current: string;
  readonly version: number;
  readonly state: 'pending' | 'delivered' | 'failed';
  readonly attempts: number;
  readonly lastStatus: number | null;
  readonly lastError: string | null;
  readonly deliveredAt: Date | null;
}

export interface BankApiOptions {
  /** The TEST partner, for its settle door only (`testPartner.settlePayment`). */
  readonly testPartner?: TestPartner | null;
  /** dev/test only: a webhook endpoint on loopback, over http, is allowed (the URL guard's hatch). */
  readonly allowLocalHttp?: boolean;
  readonly transport?: WebhookTransport;
  readonly resolver?: WebhookResolver;
  /** How long one delivery attempt may take. */
  readonly deliveryTimeoutMs?: number;
}

const MOVE_KEY = (userId: string, dedupeId: string) => `bank.api.move:${userId}:${dedupeId}`;
const PAY_KEY = (userId: string, key: string) => `pay:${userId}:${key}`;
const EVENT_ID = (paymentId: string, version: number) => `bank.transfer.state_changed:${paymentId}:${version}`;
/** The partner's answers that mean the payment was not made and never will be under this key. */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  'rail.bank',
  'bank.partner_insufficient_funds',
  'bank.partner_amount_invalid',
  'bank.account_restricted',
  'bank.asset_mismatch',
]);
const SPEND_PAGE = 1_000;
const LEASE_MS = 60_000;
const DRAIN_BATCH = 20;

interface QuoteRow {
  quote_id: string;
  user_id: string;
  from_space_id: string;
  to_space_id: string;
  asset_id: string;
  amount: string;
  fee: string | null;
  receives: string | null;
  label: string;
  quoted_at: Date;
  valid_until: Date;
}
interface MoveRow {
  user_id: string;
  dedupe_id: string;
  quote_id: string;
  partner_key: string;
  state: 'pending' | 'completed';
  partner_move_id: string | null;
  completed_at: Date | null;
}
interface PaymentRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  partner_key: string;
  from_space_id: string;
  asset_id: string;
  method: PartnerPaymentMethod;
  recipient: PartnerPaymentRecipient;
  amount: string;
  state: ApiPaymentState;
  refusal_code: string | null;
  partner_payment_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
interface DeliveryRow {
  event_id: string;
  endpoint_id: string;
  payment_id: string;
  previous_state: string | null;
  current_state: string;
  version: number;
  state: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  delivered_at: Date | null;
}

const amountText = (raw: string) => formatAmount(parseAmount(raw));
const quoteView = (q: QuoteRow): ApiMoveQuote => ({
  quoteId: q.quote_id,
  fromAccountId: q.from_space_id,
  toAccountId: q.to_space_id,
  assetId: q.asset_id,
  amount: amountText(q.amount),
  fee: q.fee === null ? null : amountText(q.fee),
  receives: q.receives === null ? null : amountText(q.receives),
  heldAt: q.label,
  quotedAt: q.quoted_at,
  validUntil: q.valid_until,
});
const deliveryView = (d: DeliveryRow): ApiDelivery => ({
  eventId: d.event_id,
  endpointId: d.endpoint_id,
  paymentId: d.payment_id,
  previous: d.previous_state,
  current: d.current_state,
  version: d.version,
  state: d.state,
  attempts: d.attempts,
  lastStatus: d.last_status,
  lastError: d.last_error,
  deliveredAt: d.delivered_at,
});

function sameRecipient(a: PartnerPaymentRecipient, b: PartnerPaymentRecipient): boolean {
  return a.name === b.name && a.accountNumber === b.accountNumber && a.routingNumber === b.routingNumber;
}

function conflict(what: string): BankError {
  return new BankError(`This ${what} was already used for a different instruction. Nothing was moved.`, 'bank.idempotency_conflict');
}

/** The UTC start of `now`'s day. */
function dayStart(now: Date): Date {
  return new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
}

export class BankApiService {
  private readonly allowLocalHttp: boolean;
  private readonly transport: WebhookTransport;
  private readonly resolver: WebhookResolver;
  private readonly timeoutMs: number;
  private draining: Promise<Array<{ outcome: string }>> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly spaces: SpaceService,
    private readonly sharedPots: SharedPotService,
    private readonly custody: PartnerCustody,
    private readonly options: BankApiOptions = {},
  ) {
    this.allowLocalHttp = options.allowLocalHttp === true;
    this.transport = options.transport ?? pinnedPost;
    this.resolver = options.resolver ?? (this.allowLocalHttp ? systemResolver : publicDnsResolver);
    this.timeoutMs = options.deliveryTimeoutMs ?? 10_000;
  }

  private partnerOf(userId: string): PartnerBank {
    const partner = this.custody.bankFor(userId);
    if (!partner) {
      throw new BankError(
        'The bank API reads and moves money the partner bank holds, and none is held there for you.',
        NO_PARTNER_BANK_CODE,
      );
    }
    return partner;
  }

  // ── Accounts (#2) ─────────────────────────────────────────────────────────

  /**
   * The caller's accounts at the partner: each currency's main balance (`standard`), their own pots (`savings`), and every
   * pot shared between people that they own or are a member of (`joint`), filtered by `type` when one is given. Each figure
   * is the partner's, and spend-today is what left the account today on the partner's own record.
   */
  async accounts(userId: string, input: { type?: ApiAccountType; limit: number }, now = new Date()): Promise<ApiAccount[]> {
    const partner = this.partnerOf(userId);
    const own = await this.spaces.list(userId, undefined, input.limit);
    const ownPots = own.filter((s) => s.kind === 'named').map((s) => s.id);
    const sharedOwn = ownPots.length
      ? await this.sql<{ space_id: string }[]>`
          SELECT DISTINCT space_id FROM bank.shared_pot_members WHERE space_id = ANY(${ownPots}::uuid[])
        `
      : [];
    const jointOwn = new Set(sharedOwn.map((r) => r.space_id));
    const memberOf = await this.sql<{ space_id: string }[]>`
      SELECT m.space_id FROM bank.shared_pot_members m JOIN bank.spaces s ON s.id = m.space_id
       WHERE m.user_id = ${userId} AND s.archived_at IS NULL AND s.removed_at IS NULL
       ORDER BY m.joined_at, m.space_id
       LIMIT ${input.limit}
    `;
    const theirs: SpaceRecord[] = [];
    for (const row of memberOf) theirs.push(await this.spaces.get(row.space_id));

    const typed: Array<{ space: SpaceRecord; type: ApiAccountType }> = [
      ...own
        .filter((s) => s.archivedAt === null)
        .map((space) => ({
          space,
          type: (space.kind === 'primary' ? 'standard' : jointOwn.has(space.id) ? 'joint' : 'savings') as ApiAccountType,
        })),
      ...theirs.map((space) => ({ space, type: 'joint' as const })),
    ];
    const wanted = typed.filter((t) => input.type === undefined || t.type === input.type).slice(0, input.limit);
    const out: ApiAccount[] = [];
    const movesOf = new Map<string, Awaited<ReturnType<PartnerBank['moves']>>>();
    for (const { space, type } of wanted) {
      const owner = this.custody.bankFor(space.userId);
      if (owner !== partner) throw partnerCustodyMismatch();
      const account = partnerAccountFor(space);
      const figure = partnerFigure(await partner.balance(account), partner.staleAfterMs, now);
      if (!movesOf.has(space.userId)) movesOf.set(space.userId, await partner.moves(space.userId, { limit: SPEND_PAGE }));
      out.push({
        id: space.id,
        type,
        name: space.name,
        assetId: space.assetId,
        owner: space.userId === userId ? 'self' : 'other',
        heldAt: partner.label,
        balance: figure.amount,
        figure: figure.state,
        asOf: figure.asOf,
        spendToday: spentToday(movesOf.get(space.userId)!, account, now),
        lockedUntil: lockEnd(space, now),
      });
    }
    return out;
  }

  // ── Moves on a quote (#3) ─────────────────────────────────────────────────

  /** The two accounts of a move, checked as the app's own transfer door checks them. Locked or archived refuses here. */
  private async sides(userId: string, fromId: string, toId: string, now: Date) {
    if (fromId === toId) throw new BankError('A transfer needs two different spaces', 'bank.same_space');
    const from = await this.spaces.resolveForDebit(fromId, now);
    if (from.userId !== userId) {
      // A shared pot's member is told only the owner takes money out; anyone else's space is not found.
      await this.sharedPots.assertMayTakeOut(userId, from);
      throw new BankError(`Space ${fromId} not found`, 'bank.space_not_found');
    }
    const to = await this.spaces.get(toId);
    if (to.archivedAt) throw new BankError(`Space "${to.name}" is archived`, 'bank.space_archived');
    if (to.userId !== userId) {
      if ((await this.sharedPots.roleOf(to.id, userId)) === null) throw new BankError(`Space ${toId} not found`, 'bank.space_not_found');
      await this.sharedPots.assertMayAddTo(userId, to.id);
    }
    const partner = this.partnerOf(userId);
    if (this.custody.bankFor(to.userId) !== partner) throw partnerCustodyMismatch();
    if (from.assetId !== to.assetId) {
      throw new BankError(`Cannot move ${from.assetId} into a ${to.assetId} account. Nothing was moved.`, 'bank.asset_mismatch');
    }
    return { from, to, partner };
  }

  /** The partner's quote for moving `amount` from one of the caller's accounts to another, kept with its exact figures. */
  async quote(
    userId: string,
    input: { fromAccountId: string; toAccountId: string; amount: Amount },
    now = new Date(),
  ): Promise<ApiMoveQuote> {
    const { from, to, partner } = await this.sides(userId, input.fromAccountId, input.toAccountId, now);
    if (!partner.quoteMove) {
      throw new BankError(
        'The partner bank gives no quote for a move between your accounts. Nothing was asked.',
        'bank.partner_quote_unavailable',
      );
    }
    const q = await partner.quoteMove({ from: partnerAccountFor(from), to: partnerAccountFor(to), amount: input.amount });
    const rows = await this.sql<QuoteRow[]>`
      INSERT INTO bank.api_move_quotes
        (quote_id, user_id, from_space_id, to_space_id, asset_id, amount, fee, receives, label, quoted_at, valid_until)
      VALUES (
        ${q.quoteId}, ${userId}, ${from.id}::uuid, ${to.id}::uuid, ${from.assetId}, ${formatAmount(q.amount)}::numeric,
        ${q.fee === null ? null : formatAmount(q.fee)}::numeric, ${q.receives === null ? null : formatAmount(q.receives)}::numeric,
        ${q.label}, ${q.quotedAt}, ${q.validUntil}
      )
      RETURNING *
    `;
    return quoteView(rows[0]!);
  }

  private async quoteRow(userId: string, quoteId: string): Promise<QuoteRow> {
    const [row] = await this.sql<QuoteRow[]>`SELECT * FROM bank.api_move_quotes WHERE quote_id = ${quoteId} AND user_id = ${userId}`;
    if (!row) throw new BankError('No quote by that id is yours.', 'bank.quote_not_found');
    return row;
  }

  private moveView(row: MoveRow, quote: QuoteRow): ApiMove {
    return {
      dedupeId: row.dedupe_id,
      quote: quoteView(quote),
      state: row.state,
      partnerMoveId: row.partner_move_id,
      completedAt: row.completed_at,
    };
  }

  /**
   * Makes the move on a quote, once per dedupe id. The intent row is written before the partner is asked; the same id with
   * another quote refuses `bank.idempotency_conflict`; the same id again answers with the same move. A pending row (the
   * partner's answer was lost) is asked again under the same key on the stored quote, whatever its valid-until.
   */
  async move(userId: string, input: { quoteId: string; dedupeId: string }, now = new Date()): Promise<ApiMove> {
    const quote = await this.quoteRow(userId, input.quoteId);
    let [row] = await this.sql<MoveRow[]>`SELECT * FROM bank.api_moves WHERE user_id = ${userId} AND dedupe_id = ${input.dedupeId}`;
    if (row && row.quote_id !== input.quoteId) throw conflict('dedupe id');
    if (row?.state === 'completed') return this.moveView(row, quote);
    const { from, to, partner } = await this.sides(userId, quote.from_space_id, quote.to_space_id, now);
    if (!row) {
      if (quote.valid_until.getTime() <= now.getTime()) {
        throw new BankError('This quote is past its valid-until. Ask for a new quote. Nothing was moved.', 'bank.quote_expired');
      }
      if (quote.fee === null) {
        throw new BankError(
          'The partner bank does not say what this move costs, so it is not made. Nothing was moved.',
          'bank.partner_fee_unknown',
        );
      }
      await this.sql`
        INSERT INTO bank.api_moves (user_id, dedupe_id, quote_id, partner_key, state)
        VALUES (${userId}, ${input.dedupeId}, ${input.quoteId}, ${MOVE_KEY(userId, input.dedupeId)}, 'pending')
        ON CONFLICT (user_id, dedupe_id) DO NOTHING
      `;
      [row] = await this.sql<MoveRow[]>`SELECT * FROM bank.api_moves WHERE user_id = ${userId} AND dedupe_id = ${input.dedupeId}`;
      if (!row || row.quote_id !== input.quoteId) throw conflict('dedupe id');
      if (row.state === 'completed') return this.moveView(row, quote);
    }
    // If this crashes after the partner moved and before the row is updated, the retry asks under the same key and the
    // partner answers with the move it made: one move, never two.
    const moved = await partner.move({
      key: row.partner_key,
      from: partnerAccountFor(from),
      to: partnerAccountFor(to),
      amount: parseAmount(quote.amount),
    });
    const [done] = await this.sql<MoveRow[]>`
      UPDATE bank.api_moves SET state = 'completed', partner_move_id = ${moved.id}, completed_at = ${moved.movedAt}
       WHERE user_id = ${userId} AND dedupe_id = ${input.dedupeId}
      RETURNING *
    `;
    return this.moveView(done!, quote);
  }

  // ── Payments (#4) ─────────────────────────────────────────────────────────

  private paymentView(row: PaymentRow): ApiPayment {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      fromAccountId: row.from_space_id,
      assetId: row.asset_id,
      method: row.method,
      recipient: row.recipient,
      amount: amountText(row.amount),
      state: row.state,
      refusalCode: row.refusal_code,
      version: row.version,
      heldAt: this.custody.bankFor(row.user_id)?.label ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private refusedAgain(row: PaymentRow): never {
    const code = row.refusal_code!;
    if (code === 'rail.bank') {
      throw new BankError(
        `An ${row.method === 'ach' ? 'ACH' : 'instant'} payment needs rail.bank. It is switched off in this build.`,
        'rail.bank',
      );
    }
    throw new BankError(`This payment was refused (${code}). Nothing was moved.`, code as never);
  }

  /**
   * One payment out, once per idempotency key. The intent row is written before the partner is asked. With no rail the row
   * is kept refused with `rail.bank`, and the same key answers the same refusal. A partner answer that may have been made
   * (a lost reply, a pause) keeps the row `asked`, and the same key asks again under the same business key.
   */
  async createPayment(
    userId: string,
    input: {
      idempotencyKey: string;
      fromAccountId: string;
      method: PartnerPaymentMethod;
      recipient: PartnerPaymentRecipient;
      amount: Amount;
    },
    now = new Date(),
  ): Promise<ApiPayment> {
    const partner = this.partnerOf(userId);
    const from = await this.spaces.resolveForDebit(input.fromAccountId, now);
    if (from.userId !== userId) {
      await this.sharedPots.assertMayTakeOut(userId, from);
      throw new BankError(`Space ${input.fromAccountId} not found`, 'bank.space_not_found');
    }
    if (this.custody.bankFor(from.userId) !== partner) throw partnerCustodyMismatch();
    const amount = formatAmount(input.amount);
    await this.sql`
      INSERT INTO bank.api_payments (user_id, idempotency_key, partner_key, from_space_id, asset_id, method, recipient, amount, state)
      VALUES (
        ${userId}, ${input.idempotencyKey}, ${PAY_KEY(userId, input.idempotencyKey)}, ${from.id}::uuid, ${from.assetId},
        ${input.method}, ${this.sql.json(input.recipient as never)}, ${amount}::numeric, 'asked'
      )
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
    `;
    const row = await this.paymentByKey(userId, input.idempotencyKey);
    if (
      row.from_space_id !== from.id ||
      row.method !== input.method ||
      parseAmount(row.amount) !== input.amount ||
      !sameRecipient(row.recipient, input.recipient)
    ) {
      throw conflict('idempotency key');
    }
    if (row.state === 'refused') this.refusedAgain(row);
    if (row.state !== 'asked') return this.paymentView(await this.refresh(row));
    if (!partner.payments) {
      await this.refuse(row, 'rail.bank');
      this.refusedAgain({ ...row, refusal_code: 'rail.bank' });
    }
    let made: PartnerPayment;
    try {
      made = await partner.payments.pay({
        key: row.partner_key,
        from: partnerAccountFor(from),
        method: input.method,
        recipient: input.recipient,
        amount: input.amount,
      });
    } catch (err) {
      if (err instanceof BankError && DEFINITE_REFUSALS.has(err.code)) await this.refuse(row, err.code);
      throw err;
    }
    return this.paymentView(await this.reported(row, made));
  }

  private async refuse(row: PaymentRow, code: string): Promise<void> {
    await this.sql`
      UPDATE bank.api_payments SET state = 'refused', refusal_code = ${code}, updated_at = now()
       WHERE id = ${row.id}::uuid AND state = 'asked'
    `;
  }

  private async paymentByKey(userId: string, key: string): Promise<PaymentRow> {
    const [row] = await this.sql<PaymentRow[]>`SELECT * FROM bank.api_payments WHERE user_id = ${userId} AND idempotency_key = ${key}`;
    if (!row) throw new BankError('No payment by that key is yours.', 'bank.payment_not_found');
    return row;
  }

  private async paymentRow(userId: string, paymentId: string): Promise<PaymentRow> {
    const [row] = await this.sql<PaymentRow[]>`SELECT * FROM bank.api_payments WHERE id = ${paymentId}::uuid AND user_id = ${userId}`;
    if (!row) throw new BankError('No payment by that id is yours.', 'bank.payment_not_found');
    return row;
  }

  /** The partner's current word on a payment it made, recorded once per version. */
  private async refresh(row: PaymentRow): Promise<PaymentRow> {
    if (row.state === 'asked' || row.state === 'refused') return row;
    const payments = this.custody.bankFor(row.user_id)?.payments;
    const now = payments ? await payments.paymentByKey(row.partner_key) : null;
    return now ? this.reported(row, now) : row;
  }

  /**
   * Records a payment state the partner reported: a version above the one kept updates the row and keeps the change as one
   * event, with one delivery per live endpoint, in one transaction. The same version again (a replay) changes nothing.
   */
  async reported(row: PaymentRow, payment: PartnerPayment): Promise<PaymentRow> {
    if (payment.key !== row.partner_key) throw partnerCustodyMismatch();
    const fresh = await this.sql.begin(async (tx) => {
      const [locked] = await tx<PaymentRow[]>`SELECT * FROM bank.api_payments WHERE id = ${row.id}::uuid FOR UPDATE`;
      if (payment.version <= locked!.version) return { row: locked!, recorded: false };
      const [updated] = await tx<PaymentRow[]>`
        UPDATE bank.api_payments
           SET state = ${payment.state}, version = ${payment.version}, partner_payment_id = ${payment.id}, updated_at = now()
         WHERE id = ${row.id}::uuid
        RETURNING *
      `;
      const eventId = EVENT_ID(row.id, payment.version);
      const inserted = await tx`
        INSERT INTO bank.api_transfer_events (event_id, user_id, payment_id, version, previous_state, current_state, occurred_at)
        VALUES (${eventId}, ${row.user_id}, ${row.id}::uuid, ${payment.version}, ${payment.previous}, ${payment.state}, ${payment.changedAt})
        ON CONFLICT DO NOTHING
        RETURNING event_id
      `;
      if (inserted.length > 0) {
        await tx`
          INSERT INTO bank.api_webhook_deliveries (event_id, endpoint_id, user_id)
          SELECT ${eventId}, e.id, e.user_id FROM bank.api_webhook_endpoints e
           WHERE e.user_id = ${row.user_id} AND e.disabled_at IS NULL
          ON CONFLICT DO NOTHING
        `;
      }
      return { row: updated!, recorded: inserted.length > 0 };
    });
    // Posted now, after the commit; a crash before it leaves the delivery due, and the recovery timer posts it.
    if (fresh.recorded) void this.drain().catch(() => undefined);
    return fresh.row;
  }

  async getPayment(userId: string, paymentId: string): Promise<ApiPayment> {
    return this.paymentView(await this.refresh(await this.paymentRow(userId, paymentId)));
  }

  async listPayments(userId: string, limit: number): Promise<ApiPayment[]> {
    const rows = await this.sql<PaymentRow[]>`
      SELECT * FROM bank.api_payments WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${limit}
    `;
    return rows.map((r) => this.paymentView(r));
  }

  /**
   * TEST stack only: the TEST partner reports the payment completed, and the report is recorded as a real partner's would
   * be. Asked again, the partner reports the same version again, which records nothing: `recorded` says which.
   */
  async settleTestPayment(userId: string, paymentId: string): Promise<{ payment: ApiPayment; recorded: boolean }> {
    const partner = this.options.testPartner;
    if (!partner) {
      throw new BankError('The TEST partner switches exist only on a stack that runs the TEST partner bank.', 'bank.test_partner_off');
    }
    const row = await this.paymentRow(userId, paymentId);
    if (!row.partner_payment_id) throw new BankError('The partner made no payment under this key.', 'bank.payment_not_found');
    const before = row.version;
    const after = await this.reported(row, partner.settlePayment(userId, row.partner_payment_id));
    return { payment: this.paymentView(after), recorded: after.version > before };
  }

  // ── Webhooks (#5) ─────────────────────────────────────────────────────────

  /** Adds an endpoint, once per `endpointId`; its signing secret is shown on the create that made it, and never again. */
  async createEndpoint(userId: string, input: { endpointId: string; url: string }): Promise<ApiWebhookEndpoint> {
    const url = assertPublicWebhookUrl(input.url, { allowLocalHttp: this.allowLocalHttp }).toString();
    const secret = `whsec_${randomBytes(32).toString('hex')}`;
    const made = await this.sql<{ id: string; url: string; created_at: Date }[]>`
      INSERT INTO bank.api_webhook_endpoints (id, user_id, url, secret) VALUES (${input.endpointId}::uuid, ${userId}, ${url}, ${secret})
      ON CONFLICT (id) DO NOTHING
      RETURNING id, url, created_at
    `;
    if (made[0]) return { id: made[0].id, url: made[0].url, createdAt: made[0].created_at, secret };
    const [prior] = await this.sql<{ id: string; user_id: string; url: string; created_at: Date }[]>`
      SELECT id, user_id, url, created_at FROM bank.api_webhook_endpoints WHERE id = ${input.endpointId}::uuid
    `;
    if (!prior || prior.user_id !== userId || prior.url !== url) throw conflict('endpoint id');
    return { id: prior.id, url: prior.url, createdAt: prior.created_at, secret: null };
  }

  async listEndpoints(userId: string, limit: number): Promise<ApiWebhookEndpoint[]> {
    const rows = await this.sql<{ id: string; url: string; created_at: Date }[]>`
      SELECT id, url, created_at FROM bank.api_webhook_endpoints
       WHERE user_id = ${userId} AND disabled_at IS NULL ORDER BY created_at, id LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, url: r.url, createdAt: r.created_at, secret: null }));
  }

  /** The caller's deliveries, newest event first, each with its attempts and the endpoint's last answer. */
  async deliveries(userId: string, input: { endpointId?: string; paymentId?: string; limit: number }): Promise<ApiDelivery[]> {
    const rows = await this.sql<DeliveryRow[]>`
      SELECT d.event_id, d.endpoint_id, e.payment_id, e.previous_state, e.current_state, e.version, d.state, d.attempts,
             d.last_status, d.last_error, d.delivered_at
        FROM bank.api_webhook_deliveries d JOIN bank.api_transfer_events e ON e.event_id = d.event_id
       WHERE d.user_id = ${userId}
         AND (${input.endpointId ?? null}::uuid IS NULL OR d.endpoint_id = ${input.endpointId ?? null}::uuid)
         AND (${input.paymentId ?? null}::uuid IS NULL OR e.payment_id = ${input.paymentId ?? null}::uuid)
       ORDER BY e.created_at DESC, d.event_id DESC, d.endpoint_id
       LIMIT ${input.limit}
    `;
    return rows.map(deliveryView);
  }

  /**
   * Posts every delivery that is due, each claimed with a lease so two workers never post one at once, and a crash mid-post
   * leaves the lease to expire and the delivery to be posted again. Every post carries the event id
   * (`x-intafaced-event-id`, also its `idempotency-key`) so a receiver keeps it once. One attempt per delivery: an endpoint
   * that does not take it is marked failed with its answer.
   */
  async drain(limit = DRAIN_BATCH): Promise<Array<{ outcome: string }>> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      const results: Array<{ outcome: string }> = [];
      try {
        while (results.length < limit) {
          const claimed = await this.sql<
            Array<DeliveryRow & { url: string; secret: string; amount: string; asset_id: string; method: string; occurred_at: Date }>
          >`
            WITH due AS (
              SELECT event_id, endpoint_id FROM bank.api_webhook_deliveries
               WHERE state = 'pending' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until <= now())
               ORDER BY next_attempt_at
               LIMIT ${Math.min(DRAIN_BATCH, limit)}
               FOR UPDATE SKIP LOCKED
            )
            UPDATE bank.api_webhook_deliveries d SET lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval
              FROM due, bank.api_transfer_events e, bank.api_webhook_endpoints w, bank.api_payments p
             WHERE d.event_id = due.event_id AND d.endpoint_id = due.endpoint_id
               AND e.event_id = d.event_id AND w.id = d.endpoint_id AND p.id = e.payment_id
            RETURNING d.event_id, d.endpoint_id, e.payment_id, e.previous_state, e.current_state, e.version, d.state,
                      d.attempts, d.last_status, d.last_error, d.delivered_at, w.url, w.secret, p.amount, p.asset_id, p.method,
                      e.occurred_at
          `;
          if (claimed.length === 0) break;
          for (const d of claimed) results.push({ outcome: (await this.post(d)) ? 'completed' : 'open' });
        }
        return results;
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private async post(
    d: DeliveryRow & { url: string; secret: string; amount: string; asset_id: string; method: string; occurred_at: Date },
  ): Promise<boolean> {
    const body = JSON.stringify({
      id: d.event_id,
      type: 'transfer.state_changed',
      transferId: d.payment_id,
      version: d.version,
      previousState: d.previous_state,
      currentState: d.current_state,
      amount: amountText(d.amount),
      assetId: d.asset_id,
      method: d.method,
      occurredAt: d.occurred_at.toISOString(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', d.secret).update(`${timestamp}.${body}`).digest('hex');
    let status: number | null = null;
    let error: string | null = null;
    try {
      const url = assertPublicWebhookUrl(d.url, { allowLocalHttp: this.allowLocalHttp });
      const addresses = await resolvePublicAddresses(url.hostname, this.resolver, { allowLoopback: this.allowLocalHttp });
      status = (
        await this.transport({
          url,
          addresses,
          body,
          timeoutMs: this.timeoutMs,
          headers: {
            'content-type': 'application/json',
            'x-intafaced-event-id': d.event_id,
            'idempotency-key': d.event_id,
            'x-intafaced-timestamp': timestamp,
            'x-intafaced-signature': `v1=${signature}`,
          },
        })
      ).status;
    } catch (err) {
      error = err instanceof BankError ? err.code : 'unreachable';
    }
    const delivered = status !== null && status >= 200 && status < 300;
    await this.sql`
      UPDATE bank.api_webhook_deliveries
         SET attempts = attempts + 1, last_status = ${status}, last_error = ${error}, lease_until = NULL,
             state = ${delivered ? 'delivered' : 'failed'}, delivered_at = ${delivered ? new Date() : null}
       WHERE event_id = ${d.event_id} AND endpoint_id = ${d.endpoint_id}::uuid
    `;
    return delivered;
  }
}

/** What left `account` since today's UTC midnight on the partner's record, or null when the page read does not reach midnight. */
function spentToday(moves: Awaited<ReturnType<PartnerBank['moves']>>, account: PartnerAccountRef, now: Date): string | null {
  const start = dayStart(now).getTime();
  const same = (a: PartnerAccountRef) => a.userId === account.userId && a.assetId === account.assetId && a.spaceId === account.spaceId;
  let spent = 0n;
  for (const move of moves) {
    if (move.movedAt.getTime() < start) return formatAmount(spent);
    // Money that left this account for anyone else's, or a payment out: not a move between the owner's own accounts.
    if (same(move.from) && move.to.userId !== account.userId) spent += move.amount;
  }
  return moves.length < SPEND_PAGE ? formatAmount(spent) : null;
}
