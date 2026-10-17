import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { convertHistoryTrpcError } from './convert-history.js';
import type { TradeService } from '../spot/trade-service.js';

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const history = convertHistoryTrpcError(err);
    if (history) throw history;
    throw err;
  }
}

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

const lifecycle = z.enum(['quoted', 'accepted', 'settled', 'refused', 'expired', 'unknown']);

const historyRow = z.object({
  quoteId: z.string(),
  inAsset: z.string(),
  outAsset: z.string(),
  inAmount: decimal,
  outAmount: decimal,
  lifecycle,
  createdAt: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
});

export function convertHistoryProcedures(trade: TradeService) {
  return {
    list: scopedProcedure('trade:read', { module: 'trade' })
      .input(
        z.object({
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.number().int().optional(),
          cursor: z.string().optional(),
        }),
      )
      .output(z.object({ rows: z.array(historyRow), nextCursor: z.string().nullable() }))
      .query(({ ctx, input }) => mapped(() => trade.convertList(ctx.principal, input))),

    status: scopedProcedure('trade:read', { module: 'trade' })
      .input(z.object({ clientConvertId: z.string().max(48) }))
      .output(
        z.object({
          status: z.enum(['none', 'quoted', 'accepted', 'settled', 'refused', 'expired', 'unknown']),
          quoteId: z.string().nullable(),
          ledgerTransactionRef: z.string().nullable(),
        }),
      )
      .query(({ ctx, input }) => mapped(() => trade.convertStatus(ctx.principal, input.clientConvertId))),
  };
}
