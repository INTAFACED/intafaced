/**
 * svc-trade's user-venue door (`/api/v1/venue/*`, services/svc-trade/src/venue/user-venue-rest.ts) as the customer's
 * venue-account room reads it (J-wallet-09 #3, #5): status with its deposit route, balances, deposits, withdrawals and
 * their terms, and the prepare and submit answers of a withdrawal. Browser-safe (zod only). Every figure is the venue's,
 * with the venue's as-of time, as decimal strings (never a number).
 */
import { z } from 'zod';

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const maybeKnown = z.union([z.object({ known: z.literal(true), value: decimal }), z.object({ known: z.literal(false) })]);

export const venueDepositRouteSchema = z.object({
  chainId: z.number().int().positive(),
  token: address,
  tokenDecimals: z.number().int().min(0).max(18),
  address,
  asset: z.string().min(1),
  // The venue's published terms (J-dex-protocol-05 #1); null or absent when it publishes none.
  minimum: decimal.nullable().optional(),
  confirmations: z.number().int().positive().nullable().optional(),
  network: z.string().min(1).nullable().optional(),
  // The venue's own warning for a transfer on any other chain (J-wallet-24 #1); null or absent when it publishes none.
  warning: z.string().min(1).nullable().optional(),
});
export type VenueDepositRoute = z.infer<typeof venueDepositRouteSchema>;

export const venueStatusSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(false),
    refusal: z.object({ code: z.string(), detail: z.string().optional() }).passthrough(),
  }),
  z
    .object({
      enabled: z.literal(true),
      available: z.literal(true),
      test: z.boolean(),
      label: z.literal('TEST').optional(),
      chainId: z.number().int().nullable(),
      deposit: venueDepositRouteSchema.nullable().optional(),
    })
    .passthrough(),
]);
export type VenueStatus = z.infer<typeof venueStatusSchema>;

export const venueBalancesSchema = z.object({
  venueId: z.string(),
  asOf: z.string(),
  value: z.array(z.object({ asset: z.string(), free: decimal, locked: decimal, total: decimal })),
});

export const venueWithdrawalSchema = z.object({
  nonce: z.string(),
  asset: z.string(),
  amount: decimal,
  destination: z.string().nullable(),
  status: z.enum(['pending', 'done', 'failed']),
  fee: maybeKnown,
  networkFee: maybeKnown,
  // The chain transaction that paid a done withdrawal, where the venue reports it (J-bank-31 #4).
  txHash: z.string().optional(),
  // When the venue took the signed withdrawal, where it reports it.
  requestedAt: z.string().optional(),
});
export type VenueWithdrawal = z.infer<typeof venueWithdrawalSchema>;
/** The venue's published withdrawal terms for an asset (J-bank-31 #3): its fee, the network fee and the arrival time. */
export const venueWithdrawalTermsSchema = z.object({
  venueId: z.string(),
  asOf: z.string(),
  value: z.object({
    asset: z.string(),
    fee: maybeKnown,
    networkFee: maybeKnown,
    arrivalSeconds: z.number().int().positive().nullable(),
  }),
});
export type VenueWithdrawalTerms = z.infer<typeof venueWithdrawalTermsSchema>['value'];
/**
 * How the venue takes each asset it lists as a deposit, as it publishes it (J-wallet-24 #5 #6): the network and the
 * venue's own words for its route, or both null where it publishes no route (not offered).
 */
export const venueDepositRoutesSchema = z.object({
  venueId: z.string(),
  asOf: z.string(),
  value: z.array(z.object({ asset: z.string().min(1), network: z.string().min(1).nullable(), how: z.string().min(1).nullable() })),
});
export type VenueAssetRoute = z.infer<typeof venueDepositRoutesSchema>['value'][number];
export const venueWithdrawalReadSchema = z.object({ venueId: z.string(), asOf: z.string(), value: venueWithdrawalSchema.nullable() });

/** One on-chain deposit as the venue reports it (J-dex-protocol-05 #2): confirming, credited, or not credited and why. */
export const venueDepositSchema = z.object({
  depositRef: z.string(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  asset: z.string(),
  amount: decimal,
  status: z.enum(['confirming', 'credited', 'not_credited']),
  confirmations: z.number().int().min(0),
  required: z.number().int().positive(),
  reason: z.enum(['below_minimum']).nullable(),
  seenAt: z.string(),
  // The venue's link to the transfer on its network's explorer: https, or a path on this app; null when it has none.
  explorerUrl: z
    .string()
    .regex(/^(https:\/\/|\/(?:[^/]|$))/)
    .nullable(),
});
export type VenueDeposit = z.infer<typeof venueDepositSchema>;
export const venueDepositsSchema = z.object({ venueId: z.string(), asOf: z.string(), value: z.array(venueDepositSchema) });

const typedDataSchema = z.object({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export const venuePreparedSchema = z.object({
  actionKey: z.string(),
  reused: z.boolean(),
  signed: z.boolean(),
  prepared: z
    .object({
      nonce: z.string(),
      digest: z.string(),
      signer: z.object({ role: z.enum(['owner', 'agent']), address: z.string() }),
      typedData: typedDataSchema,
    })
    .passthrough(),
});
export type VenuePrepared = z.infer<typeof venuePreparedSchema>;

const refusalSchema = z.object({ code: z.string(), detail: z.string() }).passthrough();
export const venueSubmittedSchema = z.object({
  actionKey: z.string(),
  outcome: z.union([
    z.object({ definite: z.literal(true), accepted: z.literal(true), venueRef: z.string().nullable(), asOf: z.string() }).passthrough(),
    z.object({ definite: z.literal(true), accepted: z.literal(false), refusal: refusalSchema, asOf: z.string() }).passthrough(),
    z.object({ definite: z.literal(false), reason: z.string() }),
  ]),
  readBack: z.union([z.object({ nonce: z.string() }), z.object({ venueClientOrderId: z.string() }), z.null()]),
});
export type VenueSubmitted = z.infer<typeof venueSubmittedSchema>;
