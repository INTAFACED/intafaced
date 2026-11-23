import { defineProcedure, NO_INPUT } from './procedure.js';
import { dropClaimInputSchema, dropClaimResultSchema, dropRoomSchema } from './campaigns-drops.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `drops.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/** The caller's drop phase: the season and points, each published drop with the caller's own claim, the TGE panel. */
export const CAMPAIGNS_DROPS_ROOM = defineProcedure({
  ...base,
  name: 'campaigns.drops.room',
  kind: 'query',
  path: 'drops.room',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: dropRoomSchema,
  samples: [{ verdict: 'accept' }],
});

/** Claims for the caller's own account only. A second call returns the first claim. */
export const CAMPAIGNS_DROPS_CLAIM = defineProcedure({
  ...base,
  name: 'campaigns.drops.claim',
  kind: 'mutation',
  path: 'drops.claim',
  access: { caller: 'scope', scope: 'campaigns:write', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: dropClaimInputSchema,
  output: dropClaimResultSchema,
  samples: [
    { verdict: 'accept', input: { dropId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
