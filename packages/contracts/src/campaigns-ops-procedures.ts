import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { ruleLibraryEntrySchema, ruleLibrarySaveInputSchema, ruleTestInputSchema, ruleTestResultSchema } from './campaigns-rules.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `ops.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/** Tries a tree on a TEST fixture account: every failing condition by its place. Reads no account, stores nothing. */
export const CAMPAIGNS_OPS_RULES_TEST = defineProcedure({
  ...base,
  name: 'campaigns.ops.rules.test',
  kind: 'query',
  path: 'ops.rules.test',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: ruleTestInputSchema,
  output: ruleTestResultSchema,
  samples: [
    { verdict: 'accept', input: { tree: { kind: 'group', op: 'and', parts: [] }, fixture: 'test-business-kp' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The name's next revision; the same tree again returns the revision it made. */
export const CAMPAIGNS_OPS_RULES_LIBRARY_SAVE = defineProcedure({
  ...base,
  name: 'campaigns.ops.rules.library.save',
  kind: 'mutation',
  path: 'ops.rules.library.save',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: ruleLibrarySaveInputSchema,
  output: ruleLibraryEntrySchema,
  samples: [
    { verdict: 'accept', input: { name: 'USDC', tree: { kind: 'group', op: 'and', parts: [] } } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const CAMPAIGNS_OPS_RULES_LIBRARY_LIST = defineProcedure({
  ...base,
  name: 'campaigns.ops.rules.library.list',
  kind: 'query',
  path: 'ops.rules.library.list',
  access: { caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', plane: 'fiat', check: 'requireOpsMfa' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(ruleLibraryEntrySchema),
  samples: [{ verdict: 'accept' }],
});
