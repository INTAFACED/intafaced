import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `ramps.destinations.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const destinationViewOutput = z.object({
  destinationId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['crypto', 'bank']),
  ref: z.string(),
  refMasked: z.string(),
  assetId: assetIdSchema.nullable(),
  network: z.string().nullable(),
  tag: z.string().nullable(),
  origin: z.enum(['legacy', 'customer']),
  state: z.enum(['pending', 'cooling', 'active', 'blocked', 'archived']),
  addedAt: z.string(),
  coolingOffEndsAt: z.string().nullable(),
  coolingBlocker: z.literal('bank.offramp_cooling_unset').nullable(),
  lookalikeConfirmedAt: z.string().nullable(),
  ownership: z
    .object({
      state: z.enum(['none', 'pending', 'verified', 'expired']),
      verifiedAt: z.string().nullable(),
      validUntil: z.string().nullable(),
      offerExpiresAt: z.string().nullable(),
    })
    .strict(),
  approvedAt: z.string().nullable(),
  approvedBy: z.enum(['link', 'device']).nullable(),
  approvalLinkExpiresAt: z.string().nullable(),
});

/**
 * Rename. Changes only the label, so `bank:write` is enough and the cooling window does not restart. It cannot
 * add or change an address; a stolen plain token could only swap labels between the customer's own saved ones.
 */
export const BANK_RAMPS_DESTINATIONS_RENAME = defineProcedure({
  ...base,
  name: 'bank.ramps.destinations.rename',
  kind: 'mutation',
  path: 'ramps.destinations.rename',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ destinationId: z.string().guid(), label: z.string().min(1).max(64) }).strict(),
  output: destinationViewOutput,
  samples: [
    { verdict: 'accept', input: { destinationId: '11111111-1111-4111-8111-111111111111', label: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
