import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-bank `convertCash.*`: the partner's cash leg of a cash-through-a-coin convert (J-cex-spot-11 #11; row d115). The
 * partner that holds a person's cash sells them the venue's quote coin for it and pays the coin into their own venue
 * account; the second leg is the venue order their wallet signs. svc-trade asks these as the person, passing on the
 * edge-signed principal of the person's own Convert request, so svc-bank's own scope and verification gates decide. Every
 * figure is the partner's; INTAFACED's ledger posts nothing. svc-bank mounts them in `router.ts`; svc-trade calls them from
 * `src/convert/cash-leg-client.ts`.
 */

const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');
const cash = z.string().regex(/^[A-Z]{3}$/);
const coin = z.string().regex(/^[A-Z0-9]{2,16}$/);
const legKey = z.string().regex(/^convert-cash:[A-Za-z0-9]{1,64}:[A-Za-z0-9_-]{8,80}$/);

export const bankCashLegOfferSchema = z
  .object({
    cash,
    coin,
    /** The coins one unit of `cash` buys, as the partner gives it. */
    rate: amount,
    /** The person's cash the partner says can move now; null when it gives no figure. */
    available: amount.nullable(),
    asOf: z.string(),
    label: z.string(),
    test: z.boolean(),
  })
  .strict();

export const bankCashLegOffersSchema = z
  .object({
    offers: z.array(bankCashLegOfferSchema),
    /** Why nothing is offered, when nothing is. */
    reason: z.string().nullable(),
  })
  .strict();
export type BankCashLegOffers = z.output<typeof bankCashLegOffersSchema>;

export const bankCashLegSchema = z
  .object({
    legKey,
    cash,
    coin,
    paid: amount,
    delivered: amount,
    rate: amount,
    venue: z.object({ venueId: z.string().min(1), owner: z.string().min(1) }).strict(),
    /** `sending`: the cash is taken and the coin not yet paid out; asking again under the key pays it once. */
    state: z.enum(['sending', 'delivered']),
    moveId: z.string(),
    movedAt: z.string(),
    deliveredAt: z.string().nullable(),
    label: z.string(),
    test: z.boolean(),
  })
  .strict();
export type BankCashLeg = z.output<typeof bankCashLegSchema>;

const STATUS = {
  'bank.cash_leg_not_offered': 'PRECONDITION_FAILED',
  'bank.cash_leg_invalid': 'BAD_REQUEST',
  'bank.cash_leg_rate_moved': 'CONFLICT',
  'bank.cash_leg_sending': 'SERVICE_UNAVAILABLE',
  'bank.partner_move_conflict': 'CONFLICT',
  'bank.partner_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.partner_insufficient_funds': 'CONFLICT',
  'bank.posting_frozen': 'SERVICE_UNAVAILABLE',
  'bank.partner_stopped': 'SERVICE_UNAVAILABLE',
} as const;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** What cash the partner converts to a coin for this person now, with its rate and the cash it says can move. */
export const BANK_CASH_LEG_OFFERS = defineProcedure({
  ...base,
  name: 'bank.convertCash.offers',
  kind: 'query',
  path: 'convertCash.offers',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: refuse(),
  input: z.object({}).strict().default({}),
  output: bankCashLegOffersSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { cash: 'EUR' } },
  ],
});

/** The cash leg under its key: the person's cash for the coin, paid into their own venue account, once per key. */
export const BANK_CASH_LEG_CARRY = defineProcedure({
  ...base,
  name: 'bank.convertCash.carry',
  kind: 'mutation',
  path: 'convertCash.carry',
  // A bank gate keeps the full verification level (BUILDER: "every bank gate keeps the full verification level").
  access: { caller: 'scope', scope: 'bank:write', module: 'bank', tier: 'full' },
  refusals: refuse(
    'bank.cash_leg_not_offered',
    'bank.cash_leg_invalid',
    'bank.cash_leg_rate_moved',
    'bank.cash_leg_sending',
    'bank.partner_move_conflict',
    'bank.partner_unavailable',
    'bank.partner_insufficient_funds',
    'bank.posting_frozen',
    'bank.partner_stopped',
  ),
  input: z
    .object({
      legKey,
      cash,
      coin,
      spend: amount,
      /** The least coin the second leg was priced with. */
      least: amount,
      venue: z.object({ venueId: z.string().min(1).max(64), owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).strict(),
    })
    .strict(),
  output: bankCashLegSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        legKey: 'convert-cash:0x1111111111111111111111111111111111111111:quote_0001',
        cash: 'EUR',
        coin: 'USDC',
        spend: '20',
        least: '21.6',
        venue: { venueId: 'test-venue', owner: '0x1111111111111111111111111111111111111111' },
      },
    },
    {
      verdict: 'refuse',
      input: { legKey: 'withdraw:1', cash: 'EUR', coin: 'USDC', spend: '20', least: '21.6', venue: { venueId: 'v', owner: '0x1' } },
    },
  ],
});

/** The person's cash leg under `key` as the partner records it; null when it made none. */
export const BANK_CASH_LEG_READ = defineProcedure({
  ...base,
  name: 'bank.convertCash.leg',
  kind: 'query',
  path: 'convertCash.leg',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: refuse(),
  input: z.object({ legKey }).strict(),
  output: z.object({ leg: bankCashLegSchema.nullable() }).strict(),
  samples: [
    { verdict: 'accept', input: { legKey: 'convert-cash:0x1111111111111111111111111111111111111111:quote_0001' } },
    { verdict: 'refuse', input: { legKey: 'other' } },
  ],
});
