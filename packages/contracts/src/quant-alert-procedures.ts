import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { quantAccountField as accountField } from './quant-wire.js';
import { quantAlertCreateInputSchema, quantAlertListSchema, quantAlertSchema } from './quant-algo.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-quant `alert.*`, one record per call: svc-quant mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc' } as const;

export const QUANT_ALERT_LIST = defineProcedure({
  ...base,
  name: 'quant.alert.list',
  kind: 'query',
  path: 'alert.list',
  access: { caller: 'jurisdiction', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: z.object({ strategyId: z.string().min(1).max(128), ...accountField }),
  output: quantAlertListSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const QUANT_ALERT_CREATE = defineProcedure({
  ...base,
  name: 'quant.alert.create',
  kind: 'mutation',
  path: 'alert.create',
  access: { caller: 'jurisdiction', module: 'quant', plane: 'fiat' },
  refusals: {},
  input: quantAlertCreateInputSchema.extend(accountField),
  output: quantAlertSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 'USDC', strategyVersion: 1, template: 'USDC', ordinal: 0 } },
    { verdict: 'refuse', input: 42 },
  ],
});
