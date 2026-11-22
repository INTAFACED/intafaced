import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `spaces.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Assets the user holds with no space yet — sourced from the ledger, not this table. */
export const BANK_SPACES_UNNAMED = defineProcedure({
  ...base,
  name: 'bank.spaces.unnamed',
  kind: 'query',
  path: 'spaces.unnamed',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(z.object({ assetId: assetIdSchema, balance: amountString })),
  samples: [{ verdict: 'accept' }],
});
