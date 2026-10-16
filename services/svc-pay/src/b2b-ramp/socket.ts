import type { Sql } from 'postgres';
import { B2bRampError } from './errors.js';
import { loadB2bRampConfig, type B2bRampEnv } from './config.js';
import { parseAsset, parsePositiveAmount, sameAmount } from './money.js';

/**
 * BANK-STATEMENT RECONCILIATION SOCKET.
 *
 * A credit is admitted only when a stored bank line matches the merchant,
 * the asset, and the scaled amount, and that line has not already been
 * credited. The client's word is not an argument of this socket: there is
 * no field for "the client says USD settled". Recording a line is how a
 * bank adapter speaks. It is not a route.
 *
 * This does not post to the ledger. Settlement of the ramp is not built.
 * `ledgerPosted` is always false, and the table forbids any other value.
 */

export interface BankStatementLine {
  readonly lineId: string;
  readonly merchantId: string;
  readonly amount: string;
  readonly asset: string;
  readonly reference: string;
  readonly postedAt: string;
  /** Only a bank statement may create a line. Any other source is rejected. */
  readonly source: 'bank_statement';
}

export interface B2bCreditInput {
  readonly merchantId: string;
  readonly bankLineId: string;
  readonly amount: string;
  readonly asset: string;
}

export interface B2bCreditResult {
  readonly creditId: string;
  readonly merchantId: string;
  readonly bankLineId: string;
  readonly amount: string;
  readonly asset: string;
  readonly reconciled: true;
  readonly ledgerPosted: false;
}

interface LineRow {
  id: string;
  merchant_id: string;
  amount: string;
  asset: string;
  reference: string;
  posted_at: Date;
}

interface CreditRow {
  id: string;
  merchant_id: string;
  amount: string;
  asset: string;
  line_id: string;
}

function pgCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return undefined;
}

function parseToken(input: string, empty: 'pay.b2b_ramp_line_rejected'): string {
  if (typeof input !== 'string') throw new B2bRampError(empty, 'bad_request');
  const value = input.trim();
  if (value.length === 0) throw new B2bRampError(empty, 'bad_request');
  return value;
}

function parsePostedAt(input: string): Date {
  if (typeof input !== 'string' || input.trim() === '') throw new B2bRampError('pay.b2b_ramp_line_rejected', 'bad_request');
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) throw new B2bRampError('pay.b2b_ramp_line_rejected', 'bad_request');
  return new Date(ms);
}

function resultOf(row: { id: string; merchant_id: string; amount: string; asset: string; line_id: string }): B2bCreditResult {
  const amount = parsePositiveAmount(row.amount);
  return {
    creditId: row.id,
    merchantId: row.merchant_id,
    bankLineId: row.line_id,
    amount: amount.canonical,
    asset: row.asset,
    reconciled: true,
    ledgerPosted: false,
  };
}

export class BankStatementReconciliation {
  constructor(
    private readonly sql: Sql,
    private readonly env: B2bRampEnv,
  ) {}

  /** Store one bank statement line. Repeating the same line is a no-op. A different payload for the same id is rejected. */
  async recordBankLine(line: BankStatementLine): Promise<{ lineId: string }> {
    if (line.source !== 'bank_statement') throw new B2bRampError('pay.b2b_ramp_line_rejected', 'bad_request');
    const lineId = parseToken(line.lineId, 'pay.b2b_ramp_line_rejected');
    const reference = parseToken(line.reference, 'pay.b2b_ramp_line_rejected');
    const asset = parseAsset(line.asset);
    const amount = parsePositiveAmount(line.amount);
    const postedAt = parsePostedAt(line.postedAt);
    if (typeof line.merchantId !== 'string' || line.merchantId.trim() === '') {
      throw new B2bRampError('pay.b2b_ramp_line_rejected', 'bad_request');
    }

    try {
      const inserted = await this.sql<Array<{ id: string }>>`
        INSERT INTO pay.b2b_ramp_bank_lines (line_id, merchant_id, amount, asset, reference, posted_at, source)
        VALUES (${lineId}, ${line.merchantId}, ${amount.canonical}, ${asset}, ${reference}, ${postedAt}, 'bank_statement')
        ON CONFLICT (line_id) DO NOTHING
        RETURNING id
      `;
      if (inserted[0]) return { lineId };
    } catch (error) {
      const code = pgCode(error);
      if (code === '23503' || code === '23514' || code === '22P02') throw new B2bRampError('pay.b2b_ramp_line_rejected', 'bad_request');
      throw new B2bRampError('pay.b2b_ramp_unavailable', 'unavailable');
    }

    const existing = await this.sql<LineRow[]>`
      SELECT id, merchant_id, amount::text AS amount, asset, reference, posted_at
        FROM pay.b2b_ramp_bank_lines
       WHERE line_id = ${lineId}
    `;
    const row = existing[0];
    if (!row) throw new B2bRampError('pay.b2b_ramp_unavailable', 'unavailable');
    const postedMs = row.posted_at instanceof Date ? row.posted_at.getTime() : Date.parse(String(row.posted_at));
    const same =
      row.merchant_id === line.merchantId &&
      row.asset === asset &&
      row.reference === reference &&
      sameAmount(row.amount, amount.canonical) &&
      postedMs === postedAt.getTime();
    if (!same) throw new B2bRampError('pay.b2b_ramp_line_rejected', 'bad_request');
    return { lineId };
  }

  /**
   * Admit a credit for one bank line. Refuses while the flag is off, and
   * refuses when no stored line matches. Does not post to the ledger.
   */
  async credit(input: B2bCreditInput): Promise<B2bCreditResult> {
    this.assertEnabled();
    const amount = parsePositiveAmount(input.amount);
    const asset = parseAsset(input.asset);
    const lineId = parseToken(input.bankLineId, 'pay.b2b_ramp_line_rejected');

    return this.sql.begin(async (tx) => {
      const lines = await tx<LineRow[]>`
        SELECT id, merchant_id, amount::text AS amount, asset, reference, posted_at
          FROM pay.b2b_ramp_bank_lines
         WHERE line_id = ${lineId}
         FOR UPDATE
      `;
      const line = lines[0];
      if (!line || line.merchant_id !== input.merchantId || line.asset !== asset || !sameAmount(line.amount, amount.canonical)) {
        throw new B2bRampError('pay.b2b_ramp_unreconciled', 'refused');
      }

      const existing = await tx<CreditRow[]>`
        SELECT c.id, c.merchant_id, c.amount::text AS amount, c.asset, l.line_id
          FROM pay.b2b_ramp_credits c
          JOIN pay.b2b_ramp_bank_lines l ON l.id = c.bank_line_pk
         WHERE c.bank_line_pk = ${line.id}
      `;
      const prior = existing[0];
      if (prior) {
        if (prior.merchant_id !== input.merchantId || prior.asset !== asset || !sameAmount(prior.amount, amount.canonical)) {
          throw new B2bRampError('pay.b2b_ramp_unreconciled', 'refused');
        }
        return resultOf(prior);
      }

      const inserted = await tx<Array<{ id: string }>>`
        INSERT INTO pay.b2b_ramp_credits (bank_line_pk, merchant_id, amount, asset)
        VALUES (${line.id}, ${input.merchantId}, ${amount.canonical}, ${asset})
        RETURNING id
      `;
      const id = inserted[0]?.id;
      if (!id) throw new B2bRampError('pay.b2b_ramp_unavailable', 'unavailable');
      return {
        creditId: id,
        merchantId: input.merchantId,
        bankLineId: lineId,
        amount: amount.canonical,
        asset,
        reconciled: true,
        ledgerPosted: false,
      };
    });
  }

  /** Read one admitted credit. While the flag is off this refuses, even in-process. */
  async get(creditId: string): Promise<B2bCreditResult | null> {
    this.assertEnabled();
    const rows = await this.sql<CreditRow[]>`
      SELECT c.id, c.merchant_id, c.amount::text AS amount, c.asset, l.line_id
        FROM pay.b2b_ramp_credits c
        JOIN pay.b2b_ramp_bank_lines l ON l.id = c.bank_line_pk
       WHERE c.id = ${creditId}
    `;
    const row = rows[0];
    return row ? resultOf(row) : null;
  }

  private assertEnabled(): void {
    const config = loadB2bRampConfig(this.env);
    if (config.mode !== 'on') throw new B2bRampError('pay.b2b_ramp_off', 'refused');
  }
}
