import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `dormancy.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_DORMANCY_NOTICES = defineProcedure({
  ...base,
  name: 'bank.dormancy.notices',
  kind: 'query',
  path: 'dormancy.notices',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(
    z.object({
      assetId: assetIdSchema,
      fee: z.string(),
      debitDate: z.string(),
      inactiveDays: z.number().int(),
      state: z.enum(['noticed', 'cancelled', 'skipped_zero', 'skipped_insufficient', 'charged']),
      partnerMoveId: z.string().nullable(),
      noticedAt: z.string(),
      settledAt: z.string().nullable(),
    }),
  ),
  samples: [{ verdict: 'accept' }],
});
