/**
 * One public trade print on the stream (`/ws/stream?channel=trades`), as the customer's chart reads it. Browser-safe
 * (zod only). Field for field `TradePrint` in `packages/market-data/src/trade.ts`, which builds it: price, size, time,
 * the engine sequence that makes the print unique, and a disclosure `kind` (`unknown` when the source named none). Money
 * is an exact decimal string.
 */
import { z } from 'zod';
import { unsignedAmountSchema } from './wire-amount.js';

/** The public tape's disclosure classes (`TRADE_PRINT_KINDS` in packages/market-data). */
export const TRADE_PRINT_KINDS = ['aggressor', 'liquidation', 'block', 'bust', 'correction', 'unknown'] as const;

export const tradePrintSchema = z.object({
  type: z.literal('trade'),
  marketId: z.string(),
  sequence: z.number().int().nonnegative().safe(),
  price: unsignedAmountSchema,
  quantity: unsignedAmountSchema,
  ts: z.string().datetime({ offset: true }),
  kind: z.enum(TRADE_PRINT_KINDS),
});
export type TradePrintWire = z.infer<typeof tradePrintSchema>;
