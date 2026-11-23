import { defineProcedure } from './procedure.js';
import { supportViewSaveInputSchema, supportViewSchema } from './support.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-support `viewsSave.*`, one record per call: svc-support mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;

/** Create or replace one view. Keyed by the caller's id, the name and the revision they read. */
export const SUPPORT_VIEWS_SAVE = defineProcedure({
  ...base,
  name: 'support.viewsSave',
  kind: 'mutation',
  path: 'viewsSave',
  access: { caller: 'scope', scope: 'support:ops' },
  refusals: {},
  input: supportViewSaveInputSchema,
  output: supportViewSchema,
  samples: [
    { verdict: 'accept', input: { name: 'USDC', expectedRevision: 0, shared: true, filter: {}, reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
