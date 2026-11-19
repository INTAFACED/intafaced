/**
 * svc-bank's portfolio reads, as the money screens read them: the valued summary and the balance breakdown. Amounts are
 * the bank's decimal strings. Browser-safe (zod only).
 */
import { z } from 'zod';

const pricedSchema = z.object({
  asset: z.string(),
  amount: z.string(),
  priceUsd: z.string(),
  valueUsd: z.string(),
  change24hUsd: z.string().nullable(),
  pair: z.string().nullable(),
});
const unpricedSchema = z.object({ asset: z.string(), amount: z.string(), reason: z.string() });
/** `bank.portfolio.summary`: every holding valued in USD, and what could not be priced, with the bank's reason. */
export const summarySchema = z.object({
  totalUsd: z.string().nullable(),
  change24hUsd: z.string().nullable(),
  cashUsd: z.string().nullable(),
  cryptoUsd: z.string().nullable(),
  priced: z.array(pricedSchema),
  unpriced: z.array(unpricedSchema),
  asOf: z.number(),
  windowStart: z.number().nullable(),
  /** Only present when the screen asked for BTC: the same total in BTC, or null with the bank's reason. */
  btc: z.object({ total: z.string().nullable(), priceUsd: z.string().nullable(), reason: z.string().nullable() }).optional(),
});

/** The bank's `bank.portfolio.balanceBreakdown` for the main account: each asset split into spendable and every lock kind. */
export const breakdownSchema = z.object({
  assets: z.array(
    z.object({
      assetId: z.string(),
      total: z.string(),
      available: z.string(),
      locked: z.array(
        z.object({
          kind: z.string(),
          amount: z.string(),
          claims: z.array(z.object({ purpose: z.string(), amount: z.string() })),
        }),
      ),
    }),
  ),
});
