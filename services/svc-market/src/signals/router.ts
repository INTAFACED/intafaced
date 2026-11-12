/**
 * `market.signals.*`: signal listings and the one card payment for access (CB-bots-api-signal-04, J-copy-bots-otc-21).
 * svc-trade reads a person's access through the internal door in index.ts, never these tables.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { MarketError } from '../vendor-service.js';
import type { SignalMarket } from './signal-market.js';

const CODE_TO_TRPC: Readonly<Record<string, TRPCError['code']>> = {
  'market.listing_not_found': 'NOT_FOUND',
  'market.purchase_self': 'CONFLICT',
  'market.signal_price_unset': 'PRECONDITION_FAILED',
  'market.signal_payment_partner_unset': 'PRECONDITION_FAILED',
  'market.signal_payment_unknown': 'SERVICE_UNAVAILABLE',
  'market.signal_price_invalid': 'BAD_REQUEST',
};

async function call<T>(market: SignalMarket | undefined, fn: (m: SignalMarket) => Promise<T>): Promise<T> {
  if (!market) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'market.signals is not wired in this process' });
  try {
    return await fn(market);
  } catch (err) {
    if (err instanceof MarketError) {
      throw new TRPCError({ code: CODE_TO_TRPC[err.code] ?? 'PRECONDITION_FAILED', message: err.message, cause: err });
    }
    throw err;
  }
}

const listingOut = z.object({
  id: z.string(),
  providerId: z.string(),
  title: z.string(),
  description: z.string(),
  assetId: z.string(),
  price: z.string().nullable(),
  createdAt: z.string(),
});
const paymentOut = z.object({
  paymentId: z.string(),
  listingId: z.string(),
  method: z.literal('card'),
  partner: z.string(),
  assetId: z.string(),
  amount: z.string(),
  status: z.enum(['pending', 'approved', 'paid', 'declined']),
  code: z.string().nullable(),
  test: z.boolean(),
  createdAt: z.string(),
});

export function signalsMarketRouter(market?: SignalMarket) {
  return router({
    publish: scopedProcedure('market:write', { module: 'market' })
      .input(
        z
          .object({
            clientListingId: z.string().min(1).max(120),
            title: z.string().trim().min(1).max(120),
            description: z.string().max(2_000),
            assetId: z.string().regex(/^[A-Z0-9]{2,12}$/),
            price: z.string().max(40).nullable(),
          })
          .strict(),
      )
      .output(listingOut)
      .mutation(({ ctx, input }) => call(market, (m) => m.publish(ctx.principal!.userId, input))),
    listings: scopedProcedure('market:read', { module: 'market' })
      .output(z.array(listingOut.extend({ payment: paymentOut.nullable(), access: z.boolean() })))
      .query(({ ctx }) => call(market, (m) => m.listings(ctx.principal!.userId))),
    buy: scopedProcedure('market:write', { module: 'market' })
      .input(z.object({ listingId: z.string().uuid() }).strict())
      .output(paymentOut)
      .mutation(({ ctx, input }) => call(market, (m) => m.buy(ctx.principal!.userId, input.listingId))),
    payments: scopedProcedure('market:read', { module: 'market' })
      .output(z.array(paymentOut))
      .query(({ ctx }) => call(market, (m) => m.payments(ctx.principal!.userId))),
  });
}
