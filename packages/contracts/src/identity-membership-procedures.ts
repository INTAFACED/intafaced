import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `membership.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const MEMBERSHIP_NOT_OFFERED = 'identity.membership_not_offered' as const;

export const tierOut = z
  .object({
    id: z.string(),
    name: z.string(),
    price: z.string(),
    assetId: assetIdSchema,
    periodDays: z.number().int(),
    perks: z.array(z.string()),
  })
  .strict();

export const offerOut = z.union([
  z.object({ offered: z.literal(false), code: z.literal(MEMBERSHIP_NOT_OFFERED) }).strict(),
  z.object({ offered: z.literal(true), tiers: z.array(tierOut), current: z.null() }).strict(),
]);

export const IDENTITY_MEMBERSHIP_OFFER = defineProcedure({
  ...base,
  name: 'identity.membership.offer',
  kind: 'query',
  path: 'membership.offer',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: offerOut,
  samples: [{ verdict: 'accept' }],
});
