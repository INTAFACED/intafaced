/**
 * Fiat buy prices for finance (J-cex-spot-17 #8): the on-ramp quotes customers were given, newest first, each with its
 * exact pay amount, fee and rate as stored when quoted. Read only: a quote holds nothing and posts nothing, and this
 * read changes no row. Amounts leave as decimal strings from `formatAmount`, the strings the customer's own read gave.
 */
import { scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { BankError } from '../errors.js';

/** At most this many rows in one read: recent prices, not an export. */
export const ONRAMP_QUOTES_LIST_MAX = 100;

export interface OnrampQuoteRow {
  readonly quoteId: string;
  readonly userId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly method: string;
  readonly country: string;
  readonly payAmount: string;
  readonly fee: string;
  readonly rate: string;
  readonly payCurrency: string;
  readonly simulated: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface Row {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  method: string;
  country: string;
  pay_amount: string;
  fee: string;
  rate: string;
  pay_currency: string;
  simulated: boolean;
  created_at: Date;
  expires_at: Date;
}

export function assertQuotesLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > ONRAMP_QUOTES_LIST_MAX) {
    throw new BankError(
      `The fiat buy quotes read needs a limit from 1 to ${ONRAMP_QUOTES_LIST_MAX} (bank.onramp_quotes_limit_unset)`,
      'bank.onramp_quotes_limit_unset',
    );
  }
  return limit;
}

const decimal = (value: string): string => formatAmount(parseAmount(value));

export async function readOnrampQuotes(sql: Sql, limit: number): Promise<OnrampQuoteRow[]> {
  const rows = await sql<Row[]>`
    SELECT id::text, user_id, asset_id, amount::text, method, country, pay_amount::text, fee::text, rate::text,
           pay_currency, simulated, created_at, expires_at
      FROM bank.ramp_onramp_quotes
     ORDER BY created_at DESC, id
     LIMIT ${assertQuotesLimit(limit)}`;
  return rows.map((row) => ({
    quoteId: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    amount: decimal(row.amount),
    method: row.method,
    country: row.country,
    payAmount: decimal(row.pay_amount),
    fee: decimal(row.fee),
    rate: decimal(row.rate),
    payCurrency: row.pay_currency,
    simulated: row.simulated,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

export function onrampQuotesProcedure(sql: () => Sql, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(z.object({ limit: z.number().int().optional() }).strict())
    .output(
      z.array(
        z.object({
          quoteId: z.string(),
          userId: z.string(),
          assetId: z.string(),
          amount: z.string(),
          method: z.string(),
          country: z.string(),
          payAmount: z.string(),
          fee: z.string(),
          rate: z.string(),
          payCurrency: z.string(),
          simulated: z.boolean(),
          createdAt: z.string(),
          expiresAt: z.string(),
        }),
      ),
    )
    .query(({ input }) => guard(async () => readOnrampQuotes(sql(), assertQuotesLimit(input.limit))));
}

/**
 * The partner's buy fees it did not give (J-cex-spot-17 #8, "or 'not known'"): each add-money request the partner's ramp
 * gave no fee for, so it was refused `bank.onramp_fee_not_known` and kept as refused. No fee, pay amount or rate was
 * quoted, so none is read: finance sees "not known", never 0. Read only, newest first.
 */
export const ONRAMP_FEE_NOT_KNOWN = 'bank.onramp_fee_not_known' as const;

export interface OnrampFeeNotKnownRow {
  readonly requestId: string;
  readonly userId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly method: string;
  readonly country: string;
  readonly refusalCode: typeof ONRAMP_FEE_NOT_KNOWN;
  readonly createdAt: string;
}

interface NotKnownRow {
  id: string;
  user_id: string;
  asset_id: string;
  amount: string;
  method: string;
  country: string;
  created_at: Date;
}

export async function readOnrampFeesNotKnown(sql: Sql, limit: number): Promise<OnrampFeeNotKnownRow[]> {
  const rows = await sql<NotKnownRow[]>`
    SELECT id::text, user_id, asset_id, amount::text, method, country, created_at
      FROM bank.add_money_requests
     WHERE status = 'refused' AND refusal_code = ${ONRAMP_FEE_NOT_KNOWN}
     ORDER BY created_at DESC, id
     LIMIT ${assertQuotesLimit(limit)}`;
  return rows.map((row) => ({
    requestId: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    amount: decimal(row.amount),
    method: row.method,
    country: row.country,
    refusalCode: ONRAMP_FEE_NOT_KNOWN,
    createdAt: row.created_at.toISOString(),
  }));
}

export function onrampFeesNotKnownProcedure(sql: () => Sql, guard: Guard) {
  return scopedProcedure('admin:read')
    .input(z.object({ limit: z.number().int().optional() }).strict())
    .output(
      z.array(
        z.object({
          requestId: z.string(),
          userId: z.string(),
          assetId: z.string(),
          amount: z.string(),
          method: z.string(),
          country: z.string(),
          refusalCode: z.literal(ONRAMP_FEE_NOT_KNOWN),
          createdAt: z.string(),
        }),
      ),
    )
    .query(({ input }) => guard(async () => readOnrampFeesNotKnown(sql(), assertQuotesLimit(input.limit))));
}
