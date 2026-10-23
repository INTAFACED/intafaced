import { createHash } from 'node:crypto';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { ListQueryError, encodeListCursor, parseListFilters } from '../list-page.js';
import { MerchantOpsError } from './errors.js';
import { iso, money } from './money.js';
import { requireLimit, toPage } from './pagination.js';
import { normalizeInvoiceLines, sumLineAmounts, type InvoiceLineInput, type InvoiceLineView } from './invoice-lines.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * Standalone invoices. A subscription execution is a different row and is not
 * written here. Sending mints a hosted payment link through the existing link
 * port and marks the invoice sent. It does not post to the ledger. Paying the
 * link is the existing payment flow; mark-paid only records that a captured or
 * settled payment of the same asset and amount already belongs to this merchant.
 */

export const INVOICE_STATUSES = ['draft', 'sent', 'void', 'paid'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

const PAID_PAYMENT = new Set(['captured', 'settled']);

export interface InvoiceLinkPort {
  createPaymentLink(input: {
    merchantId: string;
    label: string;
    amount?: bigint;
    currency?: string;
    maxUses?: number;
  }): Promise<{ id: string; token: string; prefix: string; label: string; expiresAt: Date; maxUses: number | null }>;
  deactivatePaymentLink?(merchantId: string, linkId: string): Promise<{ deactivated: boolean }>;
}

export interface InvoiceView {
  readonly id: string;
  readonly status: InvoiceStatus;
  readonly assetId: string;
  readonly amount: string;
  readonly customerRef: string | null;
  readonly customerEmail: string | null;
  readonly description: string | null;
  readonly dueAt: string | null;
  readonly lineItems: readonly InvoiceLineView[];
  readonly paymentLinkId: string | null;
  readonly paymentId: string | null;
  readonly sentAt: string | null;
  readonly voidedAt: string | null;
  readonly paidAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InvoicePaymentLinkView {
  readonly id: string;
  readonly prefix: string;
  readonly expiresAt: string | null;
  readonly maxUses: number | null;
  /** Present on the send that minted the link. A retry cannot show it again. */
  readonly token: string | null;
  readonly alreadyIssued: boolean;
}

interface InvoiceRow {
  id: string;
  status: string;
  asset_id: string;
  amount: string;
  customer_ref: string | null;
  customer_email: string | null;
  description: string | null;
  due_at: Date | null;
  payment_link_id: string | null;
  payment_id: string | null;
  sent_at: Date | null;
  voided_at: Date | null;
  paid_at: Date | null;
  created_at: Date;
  created_at_cursor: string;
  updated_at: Date;
}

interface ActionRow {
  invoice_id: string;
  action: string;
  fingerprint: string;
}

const notFound = () => new MerchantOpsError('pay.invoice_not_found', 'not_found');

export function parseInvoiceAmount(raw: string): bigint {
  if (typeof raw !== 'string' || raw !== raw.trim() || raw.startsWith('+') || raw.startsWith('-') || raw.length === 0) {
    throw new MerchantOpsError('pay.invoice_amount_invalid', 'bad_request');
  }
  let amount: bigint;
  try {
    amount = parseAmount(raw);
  } catch {
    throw new MerchantOpsError('pay.invoice_amount_invalid', 'bad_request');
  }
  if (amount <= 0n) throw new MerchantOpsError('pay.invoice_amount_invalid', 'bad_request');
  return amount;
}

function fingerprint(action: string, parts: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([action, ...parts]))
    .digest('hex');
}

/**
 * One character of the local part and one of the domain, then the public suffix.
 * `buyer@example.com` becomes `b***@e***.com`. Null stays null.
 */
export function maskCustomerEmail(email: string | null): string | null {
  if (email === null) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const localMasked = `${local[0]}***`;
  const domainMasked = dot > 0 ? `${domain[0]}***${domain.slice(dot)}` : `${domain[0] ?? '*'}***`;
  return `${localMasked}@${domainMasked}`;
}

/** The interactive owner session. An API key and every other team role stay masked. */
function revealsCustomerEmail(caller: MerchantCaller): boolean {
  return caller.role === 'owner' && caller.interactive && !caller.viaApiKey;
}

function view(row: InvoiceRow, lineItems: readonly InvoiceLineView[] = [], revealEmail = false): InvoiceView {
  return {
    id: row.id,
    status: row.status as InvoiceStatus,
    assetId: row.asset_id,
    amount: money(row.amount),
    customerRef: row.customer_ref,
    customerEmail: revealEmail ? row.customer_email : maskCustomerEmail(row.customer_email),
    description: row.description,
    dueAt: row.due_at ? iso(row.due_at) : null,
    lineItems,
    paymentLinkId: row.payment_link_id,
    paymentId: row.payment_id,
    sentAt: row.sent_at ? iso(row.sent_at) : null,
    voidedAt: row.voided_at ? iso(row.voided_at) : null,
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function statusError(status: string): MerchantOpsError {
  if (status === 'paid') return new MerchantOpsError('pay.invoice_paid', 'conflict');
  if (status === 'void') return new MerchantOpsError('pay.invoice_void', 'conflict');
  if (status === 'sent') return new MerchantOpsError('pay.invoice_already_sent', 'conflict');
  return new MerchantOpsError('pay.invoice_not_draft', 'conflict');
}

function linkLabel(description: string | null): string {
  const base = description?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Invoice';
  return base.slice(0, 120);
}

function payRefusal(error: unknown): never {
  if (error instanceof Error && error.name === 'PayError' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && code.startsWith('pay.')) {
      throw new MerchantOpsError(code as `pay.${string}`, 'precondition');
    }
  }
  throw error;
}

const uniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

export class InvoiceService {
  constructor(
    private readonly sql: Sql,
    private readonly links?: InvoiceLinkPort,
  ) {}

  async create(
    caller: MerchantCaller,
    input: {
      requestId: string;
      assetId: string;
      amount: string;
      customerRef?: string;
      customerEmail?: string;
      description?: string;
      dueAt?: string;
      lineItems?: InvoiceLineInput[];
    },
  ): Promise<InvoiceView> {
    assertPermission(caller, 'invoices.write');
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(input.assetId)) throw new MerchantOpsError('pay.invoice_asset_invalid', 'bad_request');
    const amount = formatAmount(parseInvoiceAmount(input.amount));
    const customerRef = blankToNull(input.customerRef, 200);
    const customerEmail = parseEmail(input.customerEmail);
    const description = blankToNull(input.description, 2000);
    const dueAt = parseDue(input.dueAt);
    const lineItems = normalizeInvoiceLines(input.lineItems);
    if (lineItems) {
      const total = sumLineAmounts(lineItems);
      if (total <= 0n) throw new MerchantOpsError('pay.invoice_total_not_positive', 'bad_request');
      if (formatAmount(total) !== amount) throw new MerchantOpsError('pay.invoice_total_mismatch', 'bad_request');
    }
    const fp = fingerprint('create', [
      input.assetId,
      amount,
      customerRef ?? '',
      customerEmail ?? '',
      description ?? '',
      dueAt ?? '',
      lineItems ? JSON.stringify(lineItems) : '',
    ]);
    const prior = await this.action(caller, input.requestId);
    if (prior) {
      this.sameAction(prior, 'create', fp);
      return this.get(caller, prior.invoice_id);
    }
    try {
      const row = await this.sql.begin(async (tx) => {
        const rows = await tx<InvoiceRow[]>`
          INSERT INTO pay.merchant_invoices (
            merchant_id, status, asset_id, amount, customer_ref, customer_email, description, due_at, created_by
          )
          VALUES (
            ${caller.merchantId}, 'draft', ${input.assetId}, ${amount}::numeric,
            ${customerRef}, ${customerEmail}, ${description}, ${dueAt}, ${caller.userId}
          )
          RETURNING ${this.returning(tx as unknown as Sql)}`;
        const inserted = rows[0];
        if (!inserted) throw new MerchantOpsError('pay.invoice_not_found', 'unavailable');
        if (lineItems) await this.insertLines(tx as unknown as Sql, inserted.id, lineItems);
        await this.recordAction(caller, input.requestId, 'create', fp, inserted.id, tx as unknown as Sql);
        return inserted;
      });
      return view(row, lineItems ?? []);
    } catch (error) {
      if (error instanceof MerchantOpsError) throw error;
      if (!uniqueViolation(error)) throw error;
      const raced = await this.action(caller, input.requestId);
      if (!raced) throw error;
      this.sameAction(raced, 'create', fp);
      return this.get(caller, raced.invoice_id);
    }
  }

  async list(
    caller: MerchantCaller,
    input: {
      limit?: number | undefined;
      cursor?: string;
      status?: InvoiceStatus;
      assetId?: string;
      search?: string;
      from?: string;
      to?: string;
    },
  ) {
    assertPermission(caller, 'invoices.read');
    const limit = requireLimit(input.limit);
    let filters;
    try {
      filters = parseListFilters({
        cursor: input.cursor,
        search: input.search,
        assetId: input.assetId,
        from: input.from,
        to: input.to,
      });
    } catch (error) {
      if (error instanceof ListQueryError) throw new MerchantOpsError(error.code, 'bad_request');
      throw error;
    }
    if (input.status !== undefined && !INVOICE_STATUSES.includes(input.status)) {
      throw new MerchantOpsError('pay.invoice_status_invalid', 'bad_request');
    }
    const cursorAt = filters.cursor?.createdAtCursor ?? null;
    const cursorId = filters.cursor?.id ?? null;
    const rows = await this.sql<InvoiceRow[]>`
      SELECT ${this.cols()}
        FROM pay.merchant_invoices
       WHERE merchant_id = ${caller.merchantId}
         AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
         AND (${filters.assetId}::text IS NULL OR asset_id = ${filters.assetId})
         AND (${filters.from}::timestamptz IS NULL OR created_at >= ${filters.from})
         AND (${filters.to}::timestamptz IS NULL OR created_at < ${filters.to})
         AND (
           ${filters.search}::text IS NULL
           OR id::text = lower(${filters.search})
           OR customer_ref = ${filters.search}
         )
         AND (
           ${cursorAt}::text IS NULL
           OR (created_at, id) < ((${cursorAt}::text)::timestamptz, ${cursorId}::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}
    `;
    const page = toPage(
      rows,
      limit,
      (row) => row,
      (row) => encodeListCursor(row.created_at_cursor, row.id),
    );
    const lines = await this.linesFor(page.items.map((row) => row.id));
    return {
      items: page.items.map((row) => view(row, lines.get(row.id) ?? [])),
      nextCursor: page.nextCursor,
    };
  }

  async get(caller: MerchantCaller, invoiceId: string): Promise<InvoiceView> {
    assertPermission(caller, 'invoices.read');
    const row = await this.owned(caller, invoiceId);
    if (!row) throw notFound();
    const lines = await this.linesFor([row.id]);
    const reveal = revealsCustomerEmail(caller);
    if (reveal && row.customer_email !== null) await this.logEmailRead(caller, row.id);
    return view(row, lines.get(row.id) ?? [], reveal);
  }

  /**
   * M-bill-07 (billing-tax-028 duplicate row): copy a draft into a new draft.
   * The copy has the same asset, amount, customer reference, description, due
   * date and lines, and no payment link (a link is only made by `send`). The
   * payer's email is NOT copied: this slice adds no new payer contact storage
   * (spec merchant-disp-bill-rep.md M-bill-07 Depends). Only a draft can be
   * duplicated; any other status refuses with its own code. Idempotent on the
   * request id: a replay returns the same copy, a reused id for another action
   * or another source refuses `pay.request_id_reused`.
   */
  async duplicate(caller: MerchantCaller, input: { requestId: string; invoiceId: string }): Promise<InvoiceView> {
    assertPermission(caller, 'invoices.write');
    const fp = fingerprint('duplicate', [input.invoiceId]);
    const prior = await this.action(caller, input.requestId);
    if (prior) {
      this.sameAction(prior, 'duplicate', fp);
      return this.get(caller, prior.invoice_id);
    }
    const source = await this.owned(caller, input.invoiceId);
    if (!source) throw notFound();
    if (source.status !== 'draft') throw statusError(source.status);
    const lines = (await this.linesFor([source.id])).get(source.id) ?? [];
    try {
      const row = await this.sql.begin(async (tx) => {
        const rows = await tx<InvoiceRow[]>`
          INSERT INTO pay.merchant_invoices (
            merchant_id, status, asset_id, amount, customer_ref, customer_email, description, due_at, created_by
          )
          VALUES (
            ${caller.merchantId}, 'draft', ${source.asset_id}, ${money(source.amount)}::numeric,
            ${source.customer_ref}, NULL, ${source.description}, ${source.due_at}, ${caller.userId}
          )
          RETURNING ${this.returning(tx as unknown as Sql)}`;
        const inserted = rows[0];
        if (!inserted) throw new MerchantOpsError('pay.invoice_not_found', 'unavailable');
        if (lines.length > 0) await this.insertLines(tx as unknown as Sql, inserted.id, lines);
        await this.recordAction(caller, input.requestId, 'duplicate', fp, inserted.id, tx as unknown as Sql);
        return inserted;
      });
      return view(row, lines);
    } catch (error) {
      if (error instanceof MerchantOpsError) throw error;
      if (!uniqueViolation(error)) throw error;
      const raced = await this.action(caller, input.requestId);
      if (!raced) throw error;
      this.sameAction(raced, 'duplicate', fp);
      return this.get(caller, raced.invoice_id);
    }
  }

  async send(caller: MerchantCaller, input: { requestId: string; invoiceId: string }) {
    assertPermission(caller, 'invoices.write');
    const fp = fingerprint('send', [input.invoiceId]);
    const prior = await this.action(caller, input.requestId);
    if (prior) {
      this.sameAction(prior, 'send', fp);
      return { invoice: await this.get(caller, prior.invoice_id), paymentLink: await this.linkView(caller, prior.invoice_id, null) };
    }
    const invoice = await this.owned(caller, input.invoiceId);
    if (!invoice) throw notFound();
    if (invoice.status !== 'draft') throw statusError(invoice.status);
    if (!this.links) throw new MerchantOpsError('pay.invoice_payment_link_unwired', 'unavailable');
    await this.assertActive(caller);
    const amount = parseInvoiceAmount(money(invoice.amount));
    let link: Awaited<ReturnType<InvoiceLinkPort['createPaymentLink']>>;
    try {
      link = await this.links.createPaymentLink({
        merchantId: caller.merchantId,
        label: linkLabel(invoice.description),
        amount,
        currency: invoice.asset_id,
        maxUses: 1,
      });
    } catch (error) {
      payRefusal(error);
    }
    let saved: InvoiceRow | null;
    try {
      saved = await this.sql.begin(async (tx) => {
        const rows = await tx<InvoiceRow[]>`
          UPDATE pay.merchant_invoices
             SET status = 'sent', payment_link_id = ${link.id}, sent_at = now(), updated_at = now()
           WHERE id = ${invoice.id} AND merchant_id = ${caller.merchantId} AND status = 'draft'
           RETURNING ${this.returning()}`;
        const row = rows[0];
        if (!row) return null;
        await this.recordAction(caller, input.requestId, 'send', fp, invoice.id, tx as unknown as Sql);
        return row;
      });
    } catch (error) {
      await this.deactivateLink(caller.merchantId, link.id);
      if (!uniqueViolation(error)) throw error;
      const raced = await this.action(caller, input.requestId);
      if (!raced) throw error;
      this.sameAction(raced, 'send', fp);
      return { invoice: await this.get(caller, raced.invoice_id), paymentLink: await this.linkView(caller, raced.invoice_id, null) };
    }
    if (!saved) {
      await this.deactivateLink(caller.merchantId, link.id);
      const current = await this.owned(caller, invoice.id);
      throw statusError(current?.status ?? 'draft');
    }
    return {
      invoice: await this.withLines(saved),
      paymentLink: {
        id: link.id,
        prefix: link.prefix,
        expiresAt: link.expiresAt.toISOString(),
        maxUses: link.maxUses,
        token: link.token,
        alreadyIssued: false,
      } satisfies InvoicePaymentLinkView,
    };
  }

  /**
   * Replace the link on a sent invoice. The previous link is deactivated
   * before a new single-use link is minted. The token is returned once;
   * the same requestId replays the invoice without it.
   */
  async reissueLink(caller: MerchantCaller, input: { requestId: string; invoiceId: string }) {
    assertPermission(caller, 'invoices.write');
    const fp = fingerprint('reissue_link', [input.invoiceId]);
    const prior = await this.action(caller, input.requestId);
    if (prior) {
      this.sameAction(prior, 'reissue_link', fp);
      return { invoice: await this.get(caller, prior.invoice_id), paymentLink: await this.linkView(caller, prior.invoice_id, null) };
    }
    const invoice = await this.owned(caller, input.invoiceId);
    if (!invoice) throw notFound();
    if (invoice.status !== 'sent' || !invoice.payment_link_id) throw statusError(invoice.status);
    if (!this.links) throw new MerchantOpsError('pay.invoice_payment_link_unwired', 'unavailable');
    await this.assertActive(caller);
    const oldLinkId = invoice.payment_link_id;
    const deactivated = await this.deactivateLink(caller.merchantId, oldLinkId);
    if (!deactivated) throw new MerchantOpsError('pay.invoice_link_deactivate_failed', 'conflict');
    const amount = parseInvoiceAmount(money(invoice.amount));
    let link: Awaited<ReturnType<InvoiceLinkPort['createPaymentLink']>>;
    try {
      link = await this.links.createPaymentLink({
        merchantId: caller.merchantId,
        label: linkLabel(invoice.description),
        amount,
        currency: invoice.asset_id,
        maxUses: 1,
      });
    } catch (error) {
      payRefusal(error);
    }
    let saved: InvoiceRow | null;
    try {
      saved = await this.sql.begin(async (tx) => {
        const rows = await tx<InvoiceRow[]>`
          UPDATE pay.merchant_invoices
             SET payment_link_id = ${link.id}, updated_at = now()
           WHERE id = ${invoice.id}
             AND merchant_id = ${caller.merchantId}
             AND status = 'sent'
             AND payment_link_id = ${oldLinkId}
           RETURNING ${this.returning()}`;
        const row = rows[0];
        if (!row) return null;
        await this.recordAction(caller, input.requestId, 'reissue_link', fp, invoice.id, tx as unknown as Sql);
        return row;
      });
    } catch (error) {
      await this.deactivateLink(caller.merchantId, link.id);
      if (!uniqueViolation(error)) throw error;
      const raced = await this.action(caller, input.requestId);
      if (!raced) throw error;
      this.sameAction(raced, 'reissue_link', fp);
      return { invoice: await this.get(caller, raced.invoice_id), paymentLink: await this.linkView(caller, raced.invoice_id, null) };
    }
    if (!saved) {
      await this.deactivateLink(caller.merchantId, link.id);
      const current = await this.owned(caller, invoice.id);
      if (!current || current.status !== 'sent') throw statusError(current?.status ?? invoice.status);
      throw new MerchantOpsError('pay.invoice_link_reissue_conflict', 'conflict');
    }
    return {
      invoice: await this.withLines(saved),
      paymentLink: {
        id: link.id,
        prefix: link.prefix,
        expiresAt: link.expiresAt.toISOString(),
        maxUses: link.maxUses,
        token: link.token,
        alreadyIssued: false,
      } satisfies InvoicePaymentLinkView,
    };
  }

  async void(caller: MerchantCaller, input: { requestId: string; invoiceId: string }): Promise<InvoiceView> {
    assertPermission(caller, 'invoices.write');
    const fp = fingerprint('void', [input.invoiceId]);
    const prior = await this.action(caller, input.requestId);
    if (prior) {
      this.sameAction(prior, 'void', fp);
      return this.get(caller, prior.invoice_id);
    }
    const invoice = await this.owned(caller, input.invoiceId);
    if (!invoice) throw notFound();
    if (invoice.status !== 'draft' && invoice.status !== 'sent') throw statusError(invoice.status);
    try {
      const saved = await this.sql.begin(async (tx) => {
        if (invoice.status === 'sent') {
          const linkId = invoice.payment_link_id;
          if (!linkId) throw new MerchantOpsError('pay.invoice_link_deactivate_failed', 'conflict');
          const dead = await tx<Array<{ id: string }>>`
            UPDATE pay.payment_links
               SET active = false
             WHERE id = ${linkId} AND merchant_id = ${caller.merchantId}
             RETURNING id`;
          if (!dead[0]) throw new MerchantOpsError('pay.invoice_link_deactivate_failed', 'conflict');
        }
        const rows = await tx<InvoiceRow[]>`
          UPDATE pay.merchant_invoices
             SET status = 'void', voided_at = now(), updated_at = now()
           WHERE id = ${invoice.id} AND merchant_id = ${caller.merchantId} AND status IN ('draft', 'sent')
           RETURNING ${this.returning()}`;
        const row = rows[0];
        if (!row) {
          const current = await tx<Array<{ status: string }>>`
            SELECT status FROM pay.merchant_invoices
             WHERE id = ${invoice.id} AND merchant_id = ${caller.merchantId}`;
          throw statusError(current[0]?.status ?? invoice.status);
        }
        await this.recordAction(caller, input.requestId, 'void', fp, invoice.id, tx as unknown as Sql);
        return row;
      });
      return this.withLines(saved);
    } catch (error) {
      if (error instanceof MerchantOpsError) throw error;
      if (!uniqueViolation(error)) throw error;
      const raced = await this.action(caller, input.requestId);
      if (!raced) throw error;
      this.sameAction(raced, 'void', fp);
      return this.get(caller, raced.invoice_id);
    }
  }

  /**
   * Associate an existing payment and mark the invoice paid. The payment must
   * already be captured or settled for the same asset and amount. This does
   * not capture, settle, or post.
   */
  async markPaidByPayment(
    caller: MerchantCaller,
    input: { requestId: string; invoiceId: string; paymentId: string },
  ): Promise<InvoiceView> {
    assertPermission(caller, 'invoices.write');
    const fp = fingerprint('mark_paid', [input.invoiceId, input.paymentId]);
    const prior = await this.action(caller, input.requestId);
    if (prior) {
      this.sameAction(prior, 'mark_paid', fp);
      return this.get(caller, prior.invoice_id);
    }
    const invoice = await this.owned(caller, input.invoiceId);
    if (!invoice) throw notFound();
    if (invoice.status !== 'draft' && invoice.status !== 'sent') throw statusError(invoice.status);
    const payments = await this.sql<Array<{ id: string; currency: string; amount: string; status: string }>>`
      SELECT id, currency, amount::text, status::text
        FROM pay.payments
       WHERE id = ${input.paymentId}::uuid AND merchant_id = ${caller.merchantId}`;
    const payment = payments[0];
    if (!payment) throw new MerchantOpsError('pay.invoice_payment_not_found', 'not_found');
    if (!PAID_PAYMENT.has(payment.status)) throw new MerchantOpsError('pay.invoice_payment_not_paid', 'precondition');
    if (payment.currency !== invoice.asset_id || parseAmount(payment.amount) !== parseInvoiceAmount(money(invoice.amount))) {
      throw new MerchantOpsError('pay.invoice_payment_mismatch', 'precondition');
    }
    let saved: InvoiceRow[];
    try {
      saved = await this.sql<InvoiceRow[]>`
        UPDATE pay.merchant_invoices
           SET status = 'paid', payment_id = ${payment.id}, paid_at = now(), updated_at = now()
         WHERE id = ${invoice.id}
           AND merchant_id = ${caller.merchantId}
           AND status IN ('draft', 'sent')
           AND NOT EXISTS (
             SELECT 1 FROM pay.merchant_invoices other
              WHERE other.payment_id = ${payment.id} AND other.id <> ${invoice.id}
           )
         RETURNING ${this.returning()}`;
    } catch (error) {
      if (uniqueViolation(error)) throw new MerchantOpsError('pay.invoice_payment_already_applied', 'conflict');
      throw error;
    }
    if (!saved[0]) {
      const taken = await this.sql<Array<{ id: string }>>`
        SELECT id FROM pay.merchant_invoices
         WHERE merchant_id = ${caller.merchantId} AND payment_id = ${payment.id} AND id <> ${invoice.id}`;
      if (taken[0]) throw new MerchantOpsError('pay.invoice_payment_already_applied', 'conflict');
      const current = await this.owned(caller, invoice.id);
      throw statusError(current?.status ?? invoice.status);
    }
    await this.recordAction(caller, input.requestId, 'mark_paid', fp, invoice.id);
    return this.withLines(saved[0]);
  }

  private cols(db: Sql = this.sql) {
    return db`id, status, asset_id, amount::text, customer_ref, customer_email, description, due_at, payment_link_id, payment_id,
      sent_at, voided_at, paid_at, created_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
      updated_at`;
  }

  private returning(db: Sql = this.sql) {
    return this.cols(db);
  }

  private async withLines(row: InvoiceRow): Promise<InvoiceView> {
    const lines = await this.linesFor([row.id]);
    return view(row, lines.get(row.id) ?? []);
  }

  private async insertLines(db: Sql, invoiceId: string, lines: readonly InvoiceLineView[]): Promise<void> {
    await db`
      INSERT INTO pay.merchant_invoice_lines ${db(
        lines.map((line, index) => ({
          invoice_id: invoiceId,
          line_no: index + 1,
          description: line.description,
          quantity: line.quantity,
          unit_amount: line.unitAmount,
          line_amount: line.amount,
          kind: line.kind,
        })),
      )}
    `;
  }

  private async linesFor(ids: readonly string[]): Promise<Map<string, InvoiceLineView[]>> {
    const grouped = new Map<string, InvoiceLineView[]>();
    if (ids.length === 0) return grouped;
    const rows = await this.sql<
      Array<{
        invoice_id: string;
        description: string;
        quantity: string;
        unit_amount: string;
        line_amount: string;
        kind: string;
      }>
    >`
      SELECT invoice_id, description, quantity::text, unit_amount::text, line_amount::text, kind
        FROM pay.merchant_invoice_lines
       WHERE invoice_id IN ${this.sql([...ids])}
       ORDER BY invoice_id, line_no
    `;
    for (const row of rows) {
      const kind = row.kind === 'credit' ? 'credit' : 'charge';
      const list = grouped.get(row.invoice_id) ?? [];
      list.push({
        kind,
        description: row.description,
        quantity: money(row.quantity),
        unitAmount: money(row.unit_amount),
        amount: money(row.line_amount),
      });
      grouped.set(row.invoice_id, list);
    }
    return grouped;
  }

  private async owned(caller: MerchantCaller, invoiceId: string): Promise<InvoiceRow | null> {
    const rows = await this.sql<InvoiceRow[]>`
      SELECT ${this.cols()}
        FROM pay.merchant_invoices
       WHERE id = ${invoiceId}::uuid AND merchant_id = ${caller.merchantId}`;
    return rows[0] ?? null;
  }

  private async assertActive(caller: MerchantCaller): Promise<void> {
    const rows = await this.sql<Array<{ status: string }>>`
      SELECT status::text FROM pay.merchants WHERE id = ${caller.merchantId}`;
    if (rows[0]?.status !== 'active') throw new MerchantOpsError('pay.merchant_inactive', 'precondition');
  }

  private async action(caller: MerchantCaller, requestId: string): Promise<ActionRow | null> {
    const rows = await this.sql<ActionRow[]>`
      SELECT invoice_id, action, fingerprint
        FROM pay.merchant_invoice_actions
       WHERE merchant_id = ${caller.merchantId} AND request_id = ${requestId}::uuid`;
    return rows[0] ?? null;
  }

  private sameAction(prior: ActionRow, action: string, fp: string): void {
    if (prior.action !== action || prior.fingerprint !== fp) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
  }

  /** One row per full-value read. The address itself is not copied into the log. */
  private async logEmailRead(caller: MerchantCaller, invoiceId: string): Promise<void> {
    await this.sql`
      INSERT INTO pay.control_audit (scope, scope_id, merchant_id, kind, outcome, actor_id, reason, after)
      VALUES (
        'merchant',
        ${invoiceId},
        ${caller.merchantId},
        'invoice.customer_email_read',
        'shown',
        ${caller.userId},
        'owner session read the customer email',
        ${this.sql.json({ invoiceId })}
      )`;
  }

  private async recordAction(
    caller: MerchantCaller,
    requestId: string,
    action: string,
    fp: string,
    invoiceId: string,
    db: Sql = this.sql,
  ): Promise<void> {
    await db`
      INSERT INTO pay.merchant_invoice_actions (merchant_id, request_id, invoice_id, action, fingerprint)
      VALUES (${caller.merchantId}, ${requestId}::uuid, ${invoiceId}, ${action}, ${fp})`;
  }

  /** Mark a link inactive. False when this merchant has no such link. */
  private async deactivateLink(merchantId: string, linkId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE pay.payment_links
         SET active = false
       WHERE id = ${linkId} AND merchant_id = ${merchantId}
       RETURNING id`;
    return rows.length > 0;
  }

  private async linkView(caller: MerchantCaller, invoiceId: string, token: string | null): Promise<InvoicePaymentLinkView | null> {
    const rows = await this.sql<Array<{ payment_link_id: string | null }>>`
      SELECT payment_link_id FROM pay.merchant_invoices
       WHERE id = ${invoiceId} AND merchant_id = ${caller.merchantId}`;
    const linkId = rows[0]?.payment_link_id;
    if (!linkId) return null;
    const links = await this.sql<Array<{ id: string; token_prefix: string; expires_at: Date | null; max_uses: number | null }>>`
      SELECT id, token_prefix, expires_at, max_uses
        FROM pay.payment_links
       WHERE id = ${linkId} AND merchant_id = ${caller.merchantId}`;
    const link = links[0];
    if (!link) return null;
    return {
      id: link.id,
      prefix: link.token_prefix,
      expiresAt: link.expires_at ? iso(link.expires_at) : null,
      maxUses: link.max_uses,
      token,
      alreadyIssued: token === null,
    };
  }
}

function parseEmail(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 254 || /[\u0000-\u001f\u007f]/.test(trimmed) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    throw new MerchantOpsError('pay.invoice_email_invalid', 'bad_request');
  }
  return trimmed;
}

function parseDue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new MerchantOpsError('pay.invoice_due_invalid', 'bad_request');
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new MerchantOpsError('pay.invoice_due_invalid', 'bad_request');
  return date.toISOString();
}

function blankToNull(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new MerchantOpsError('pay.invoice_text_invalid', 'bad_request');
  }
  return trimmed;
}
