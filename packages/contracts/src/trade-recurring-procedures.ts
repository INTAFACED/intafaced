import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-trade's recurring buy of a basket on the person's own venue account (J-copy-bots-otc-16; svc-trade
 * src/recurring/recurring-buys.ts). INTAFACED holds and moves nothing: each slot buys each basket coin as one venue spot
 * order on the person's own account, signed by the recurring-buy agent permission their wallet approves once, under the
 * slot's own key (`recurring:<ruleId>:<slot>:<symbol>`). Ending the rule sells what it bought back to the quote once, as
 * venue orders under `recurring:<ruleId>:convert:<symbol>`. Cost and value are read from the venue's fills and book.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'trade' } as const;

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
/** A decimal typed by the person, or blank: the service names a blank or malformed field in its refusal. */
const typed = z.string().max(64).optional().nullable();

export const RECURRING_FREQUENCIES = ['hourly', 'daily', 'weekly'] as const;
export const RECURRING_STATUSES = ['signing', 'active', 'suspended_insufficient_funds', 'completed', 'terminated'] as const;

/** A recurring buy rule as the person reads it: every figure a decimal string, read from the venue's own record. */
export const recurringRuleSchema = z.object({
  ruleId: z.string(),
  clientRequestId: z.string(),
  status: z.enum(RECURRING_STATUSES),
  statusReason: z.string().nullable(),
  quoteAsset: z.string(),
  /** What each slot spends, in the quote, split across the basket by weight. */
  amount: decimal,
  frequency: z.enum(RECURRING_FREQUENCIES),
  /** The most the rule may spend in all; null is "Not set": the rule never closes itself. */
  maxInvestment: decimal.nullable(),
  funding: z.literal('venue'),
  basket: z.array(
    z.object({
      symbol: z.string(),
      baseAsset: z.string(),
      weightPct: decimal,
      lowestPrice: decimal.nullable(),
      highestPrice: decimal.nullable(),
    }),
  ),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  slots: z.array(
    z.object({
      slot: z.number().int(),
      at: z.string(),
      amount: decimal,
      outcome: z.enum(['pending', 'bought', 'skipped_insufficient_funds', 'skipped_not_permitted']),
      spent: decimal,
      orders: z.array(
        z.object({
          orderKey: z.string(),
          symbol: z.string(),
          status: z.enum(['open', 'filled', 'partial', 'cancelled', 'refused', 'skipped_price_range']),
          qty: decimal,
          filled: decimal,
          spent: decimal,
        }),
      ),
    }),
  ),
  conversions: z.array(
    z.object({
      orderKey: z.string(),
      symbol: z.string(),
      status: z.enum(['open', 'filled', 'partial', 'cancelled', 'refused']),
      qty: decimal,
      filled: decimal,
      received: decimal,
    }),
  ),
  /**
   * The share card's figures: cost is what the slots spent, fees in the quote included; value is what the coins the rule
   * holds are worth at the venue's mark (the mid of its best bid and ask), null when any coin has no mark; the profit
   * percentage only with a value.
   */
  result: z.object({ cost: decimal, value: decimal.nullable(), profitPct: decimal.nullable() }),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    test: z.boolean(),
    owner: z.string(),
    agentAddress: z.string(),
    agentName: z.string(),
  }),
  /** The recurring-buy agent permission the person's wallet is asked to sign, while the rule is signing. */
  next: z
    .object({
      actionKey: z.string(),
      digest: z.string(),
      typedData: z.object({
        domain: z.record(z.string(), z.union([z.string(), z.number()])),
        types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
        primaryType: z.string(),
        message: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      }),
    })
    .nullable(),
});

const refuse = (map: Record<string, 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE'>): Refusals =>
  Object.freeze(map);

const COMMON = {
  'trade.recurring_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.bots_verification_insufficient': 'FORBIDDEN',
  'trade.bots_verification_level_not_set': 'FORBIDDEN',
} as const;

const RULE = '7b1e4c2a-9d3f-5a6b-8c7d-1e2f3a4b5c6d';

/**
 * Save a recurring buy (J-copy-bots-otc-16 #2 #4). Refused naming the field: weights that do not total 100, a row whose
 * lowest price is not below its highest, a blank or non-positive amount, card funding (switched off in this build), a coin
 * the venue does not list. Nothing is saved on a refusal. Saved, it waits for the wallet's agent permission, then buys.
 */
export const RECURRING_CREATE = defineProcedure({
  ...base,
  name: 'trade.bots.recurring.create',
  kind: 'mutation',
  path: 'bots.recurring.create',
  access: WRITE,
  refusals: refuse({
    ...COMMON,
    'trade.recurring_field_invalid': 'BAD_REQUEST',
    'trade.recurring_weights_not_100': 'BAD_REQUEST',
    'trade.recurring_price_range_inverted': 'BAD_REQUEST',
    'trade.recurring_card_funding_off': 'BAD_REQUEST',
    'trade.recurring_market_not_found': 'BAD_REQUEST',
    'trade.recurring_wallet_required': 'BAD_REQUEST',
    'trade.recurring_builder_fee_unapproved': 'BAD_REQUEST',
    'trade.recurring_agent_key_unset': 'BAD_REQUEST',
    'trade.recurring_request_conflict': 'CONFLICT',
    'trade.bots_paused_by_platform': 'BAD_REQUEST',
  }),
  input: z.object({
    clientRequestId: z.string().min(8).max(120),
    owner: z.string().max(64).optional().nullable(),
    funding: z.enum(['venue', 'card']),
    basket: z
      .array(
        z.object({
          symbol: z.string().min(3).max(64),
          weightPct: typed,
          lowestPrice: typed,
          highestPrice: typed,
        }),
      )
      .min(1)
      .max(10),
    amount: typed,
    frequency: z.enum(RECURRING_FREQUENCIES),
    maxInvestment: typed,
  }),
  output: recurringRuleSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        clientRequestId: 'recurring-sample-0001',
        owner: '0x1111111111111111111111111111111111111111',
        funding: 'venue',
        basket: [
          { symbol: 'BTC-USDC', weightPct: '50' },
          { symbol: 'ETH-USDC', weightPct: '30' },
          { symbol: 'SOL-USDC', weightPct: '20', lowestPrice: '100', highestPrice: '200' },
        ],
        amount: '10',
        frequency: 'daily',
        maxInvestment: null,
      },
    },
    { verdict: 'refuse', input: { clientRequestId: 'short', funding: 'venue', basket: [], frequency: 'daily' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The wallet's signature of the recurring-buy agent permission, sent once under its key; the rule then buys its first slot. */
export const RECURRING_SUBMIT_PERMISSION = defineProcedure({
  ...base,
  name: 'trade.bots.recurring.submitPermission',
  kind: 'mutation',
  path: 'bots.recurring.submitPermission',
  access: WRITE,
  refusals: refuse({
    'trade.recurring_unavailable': 'SERVICE_UNAVAILABLE',
    'trade.recurring_not_found': 'NOT_FOUND',
    'trade.recurring_not_signing': 'CONFLICT',
    'trade.recurring_agent_key_unset': 'BAD_REQUEST',
  }),
  input: z.object({
    ruleId: z.string().min(1).max(64),
    actionKey: z.string().min(3).max(200),
    signature: z.object({
      digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      signedBy: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    }),
  }),
  output: recurringRuleSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        ruleId: RULE,
        actionKey: 'recurring-agent:0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222',
        signature: {
          digest: `0x${'ab'.repeat(32)}`,
          signature: `0x${'cd'.repeat(65)}`,
          signedBy: '0x1111111111111111111111111111111111111111',
        },
      },
    },
    { verdict: 'refuse', input: { ruleId: 'x', actionKey: 'r', signature: { digest: '0x1', signature: '0x', signedBy: 'me' } } },
    { verdict: 'refuse', input: {} },
  ],
});

/** One of the person's recurring buys, with its slots, conversions and result. */
export const RECURRING_GET = defineProcedure({
  ...base,
  name: 'trade.bots.recurring.get',
  kind: 'query',
  path: 'bots.recurring.get',
  access: READ,
  refusals: refuse({ 'trade.recurring_unavailable': 'SERVICE_UNAVAILABLE', 'trade.recurring_not_found': 'NOT_FOUND' }),
  input: z.object({ ruleId: z.string().min(1).max(64) }),
  output: recurringRuleSchema,
  samples: [
    { verdict: 'accept', input: { ruleId: RULE } },
    { verdict: 'refuse', input: { ruleId: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Every recurring buy of the person, newest first. */
export const RECURRING_LIST = defineProcedure({
  ...base,
  name: 'trade.bots.recurring.list',
  kind: 'query',
  path: 'bots.recurring.list',
  access: READ,
  refusals: refuse({ 'trade.recurring_unavailable': 'SERVICE_UNAVAILABLE' }),
  input: z.object({}).optional(),
  output: z.array(recurringRuleSchema),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { limit: 'all' } },
  ],
});

/**
 * Change what the next slots spend (J-copy-bots-otc-16 #5): the next slot buys the new amount; a slot already run keeps
 * the amount it ran with. A blank maximum leaves it Not set.
 */
export const RECURRING_UPDATE = defineProcedure({
  ...base,
  name: 'trade.bots.recurring.update',
  kind: 'mutation',
  path: 'bots.recurring.update',
  access: WRITE,
  refusals: refuse({
    ...COMMON,
    'trade.recurring_not_found': 'NOT_FOUND',
    'trade.recurring_ended': 'CONFLICT',
    'trade.recurring_field_invalid': 'BAD_REQUEST',
  }),
  input: z.object({ ruleId: z.string().min(1).max(64), amount: typed, maxInvestment: typed }),
  output: recurringRuleSchema,
  samples: [
    { verdict: 'accept', input: { ruleId: RULE, amount: '20', maxInvestment: null } },
    { verdict: 'refuse', input: { ruleId: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * End a recurring buy (J-copy-bots-otc-16 #7): no slot runs again, and what it bought is sold back to the quote once, each
 * coin one venue order under its own key. Ending it again sends nothing more.
 */
export const RECURRING_TERMINATE = defineProcedure({
  ...base,
  name: 'trade.bots.recurring.terminate',
  kind: 'mutation',
  path: 'bots.recurring.terminate',
  access: WRITE,
  refusals: refuse({ ...COMMON, 'trade.recurring_not_found': 'NOT_FOUND' }),
  input: z.object({ ruleId: z.string().min(1).max(64) }),
  output: recurringRuleSchema,
  samples: [
    { verdict: 'accept', input: { ruleId: RULE } },
    { verdict: 'refuse', input: { ruleId: '' } },
    { verdict: 'refuse', input: {} },
  ],
});
