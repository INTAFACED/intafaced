import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { SORTER_MAX_LEGS, sorterView } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `sorter.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * Make the sorter for one asset. `sorterId` is the client's request id, so a retry is the same sorter. Shares are
 * whole basis points; over 10000 in all refuses `bank.sorter_invalid`.
 */
export const BANK_SORTER_CREATE = defineProcedure({
  ...base,
  name: 'bank.sorter.create',
  kind: 'mutation',
  path: 'sorter.create',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      sorterId: z.string().guid(),
      assetId: assetIdSchema.trim().min(1).max(16),
      legs: z
        .array(z.object({ spaceId: z.string().guid(), shareBp: z.number().int() }).strict())
        .min(1)
        .max(SORTER_MAX_LEGS),
    })
    .strict(),
  output: sorterView,
  samples: [
    {
      verdict: 'accept',
      input: {
        sorterId: '11111111-1111-4111-8111-111111111111',
        assetId: 'USDC',
        legs: [{ spaceId: '11111111-1111-4111-8111-111111111111', shareBp: -9007199254740991 }],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Stop sorting. Credits already sorted stay where they went. */
export const BANK_SORTER_CANCEL = defineProcedure({
  ...base,
  name: 'bank.sorter.cancel',
  kind: 'mutation',
  path: 'sorter.cancel',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ sorterId: z.string().guid() }).strict(),
  output: sorterView,
  samples: [
    { verdict: 'accept', input: { sorterId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
