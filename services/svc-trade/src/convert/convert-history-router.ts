import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { convertHistoryTrpcError } from './convert-history.js';
import type { TradeService } from '../spot/trade-service.js';
import { TRADE_CONVERT_LIST } from '@intafaced/contracts/trade-convert-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { tradeRefusal } from '../record-refusal.js';

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const history = convertHistoryTrpcError(err);
    if (history) throw history;
    throw err;
  }
}

export function convertHistoryProcedures(trade: TradeService) {
  return {
    list: mountRecord(TRADE_CONVERT_LIST, ({ ctx, input }) => mapped(() => trade.convertList(ctx.principal, input)), tradeRefusal),

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
