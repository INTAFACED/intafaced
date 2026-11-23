import { defineProcedure } from './procedure.js';
import { quantLakeCatalogueInputSchema, quantLakeCatalogueSchema } from './quant-research.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `lake.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

export const QUANT_LAKE_CATALOGUE = defineProcedure({
  ...base,
  name: 'quant.lake.catalogue',
  kind: 'query',
  path: 'lake.catalogue',
  access: { caller: 'jurisdiction', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantLakeCatalogueInputSchema,
  output: quantLakeCatalogueSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
