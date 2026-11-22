import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `eligibility.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Public: who can open an account is readable before sign-up. A region adds the platform's own verdict for it. */
export const BANK_ELIGIBILITY_GET = defineProcedure({
  ...base,
  name: 'bank.eligibility.get',
  kind: 'query',
  path: 'eligibility.get',
  access: { caller: 'public' },
  refusals: {},
  input: z
    .object({
      region: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/)
        .optional(),
    })
    .strict()
    .optional(),
  output: z.object({
    rules: z.object({
      countries: z.array(z.string()),
      entityTypes: z.array(z.string()),
      productRestrictions: z.array(z.object({ product: z.string(), restriction: z.string() })),
    }),
    verdict: z
      .object({
        region: z.string(),
        status: z.enum(['open', 'restricted', 'blocked']),
        minTier: z.string(),
        notes: z.string().nullable(),
        source: z.literal('JURISDICTION_MATRIX'),
        listed: z.boolean(),
      })
      .nullable(),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
