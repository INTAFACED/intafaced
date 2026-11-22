import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-p2p `ops.*`, one record per call: svc-p2p mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-p2p', module: 'p2p', transport: 'trpc' } as const;

export const P2P_OPS_OFFERS = defineProcedure({
  ...base,
  name: 'p2p.ops.offers',
  kind: 'query',
  path: 'ops.offers',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'p2p' },
  refusals: {},
  input: z.object({
    status: z.enum(['active', 'paused', 'closed']),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(500).nullable().optional(),
  }),
  output: z.object({
    offers: z.array(
      z.object({
        id: z.string().guid(),
        makerId: z.string(),
        side: z.enum(['buy', 'sell']),
        asset: z.string(),
        fiatCurrency: z.string(),
        price: z.string(),
        minAmount: z.string(),
        maxAmount: z.string(),
        totalAmount: z.string(),
        remainingAmount: z.string(),
        status: z.enum(['active', 'paused', 'closed']),
        methodIds: z.array(z.string()),
        createdAt: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { status: 'active' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const P2P_OPS_TRADES = defineProcedure({
  ...base,
  name: 'p2p.ops.trades',
  kind: 'query',
  path: 'ops.trades',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'p2p' },
  refusals: {},
  input: z.object({
    status: z.enum(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(500).nullable().optional(),
  }),
  output: z.object({
    trades: z.array(
      z.object({
        id: z.string().guid(),
        offerId: z.string().guid(),
        makerId: z.string(),
        takerId: z.string(),
        buyerId: z.string(),
        sellerId: z.string(),
        asset: z.string(),
        fiatCurrency: z.string(),
        amount: z.string(),
        price: z.string(),
        fiatAmount: z.string(),
        method: z.string(),
        feeBps: z.number().int(),
        status: z.enum(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']),
        resolution: z.enum(['released', 'refunded', 'voided']).nullable(),
        createdAt: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { status: 'created' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const P2P_OPS_LATE_SETTLEMENTS = defineProcedure({
  ...base,
  name: 'p2p.ops.lateSettlements',
  kind: 'query',
  path: 'ops.lateSettlements',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'p2p' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional here so omit reaches the service named
       * refuse (`p2p.late_settlements_list_limit_unset`) instead of a
       * Zod "Required" that looks like a typo. Blank is not 100; pass
       * 100 explicitly when that is the page you want.
       */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
  output: z.object({
    trades: z.array(
      z.object({
        tradeId: z.string().guid(),
        status: z.enum(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']),
        resolution: z.enum(['released', 'refunded', 'voided']).nullable(),
        resolutionReason: z.string().nullable(),
        resolvedAt: z.string(),
        ageSeconds: z.number().int().nonnegative(),
        lastSettleError: z.string().nullable(),
        lastSettleErrorAt: z.string().nullable(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const P2P_OPS_COUNTS = defineProcedure({
  ...base,
  name: 'p2p.ops.counts',
  kind: 'query',
  path: 'ops.counts',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'p2p' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    offers: z.object({
      active: z.number().int().nonnegative(),
      paused: z.number().int().nonnegative(),
      closed: z.number().int().nonnegative(),
    }),
    trades: z.object({
      created: z.number().int().nonnegative(),
      escrowed: z.number().int().nonnegative(),
      fiat_sent: z.number().int().nonnegative(),
      released: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
      disputed: z.number().int().nonnegative(),
    }),
  }),
  samples: [{ verdict: 'accept' }],
});

export const P2P_OPS_DISPUTE_RATE24H = defineProcedure({
  ...base,
  name: 'p2p.ops.disputeRate24h',
  kind: 'query',
  path: 'ops.disputeRate24h',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'p2p' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    disputesOpened24h: z.number().int().nonnegative(),
    tradesCreated24h: z.number().int().nonnegative(),
    rate: z.string().nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});
