import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { quantAccountField as accountField } from './quant-wire.js';
import { strategyMetadata, STUDIO_LIST_LIMIT_CAP } from './quant-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `studio.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

/**
 * Every account's metadata. Admin scope required. No source and no blocks.
 * A body accountId is ignored — this is not a way to read one user's source.
 */
export const QUANT_STUDIO_OPERATOR_LIST = defineProcedure({
  ...base,
  name: 'quant.studio.operatorList',
  kind: 'query',
  path: 'studio.operatorList',
  access: { caller: 'jurisdiction', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: z
    .object({
      limit: z.number().int().min(1).max(STUDIO_LIST_LIMIT_CAP).optional(),
      ...accountField,
    })
    .optional(),
  output: z.object({ strategies: z.array(strategyMetadata), quarantineCount: z.number().int().nonnegative() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
