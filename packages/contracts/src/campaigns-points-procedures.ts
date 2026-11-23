import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { pointsConvertInputSchema, pointsProgrammeSchema, pointsRedeemInputSchema } from './campaigns-points.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `points.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/** The points programme: its full layout, with every number blank and the owner question named while it is open. */
export const CAMPAIGNS_POINTS_PROGRAMME = defineProcedure({
  ...base,
  name: 'campaigns.points.programme',
  kind: 'query',
  path: 'points.programme',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: NO_INPUT,
  output: pointsProgrammeSchema,
  samples: [{ verdict: 'accept' }],
});

/** Converting points to cash waits for the owner decision: always refuses, before anything is read or stored. */
export const CAMPAIGNS_POINTS_CONVERT = defineProcedure({
  ...base,
  name: 'campaigns.points.convert',
  kind: 'mutation',
  path: 'points.convert',
  access: { caller: 'scope', scope: 'campaigns:write', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: pointsConvertInputSchema,
  output: z.never(),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Redeeming a catalogue reward waits for the owner decision: always refuses, before anything is read or stored. */
export const CAMPAIGNS_POINTS_REDEEM = defineProcedure({
  ...base,
  name: 'campaigns.points.redeem',
  kind: 'mutation',
  path: 'points.redeem',
  access: { caller: 'scope', scope: 'campaigns:write', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: pointsRedeemInputSchema,
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { itemId: 'fee_saver' } },
    { verdict: 'refuse', input: 42 },
  ],
});
