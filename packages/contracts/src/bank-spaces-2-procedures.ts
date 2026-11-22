import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString, potStateOutput } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `spaces.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Set, change or clear the goal of one of the caller's pots (BK-pots-02). A target, never a holding: nothing moves. */
export const BANK_SPACES_SET_GOAL = defineProcedure({
  ...base,
  name: 'bank.spaces.setGoal',
  kind: 'mutation',
  path: 'spaces.setGoal',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ spaceId: z.string().guid(), goalTarget: amountString.nullable() }),
  output: potStateOutput,
  samples: [
    { verdict: 'accept', input: { spaceId: '11111111-1111-4111-8111-111111111111', goalTarget: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_SPACES_CREATE = defineProcedure({
  ...base,
  name: 'bank.spaces.create',
  kind: 'mutation',
  path: 'spaces.create',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    assetId: assetIdSchema.min(1).max(16),
    name: z.string().min(1).max(64),
    goalTarget: amountString.optional(),
    lockedUntil: z.string().datetime({ offset: true }).optional(),
  }),
  output: z.object({ id: z.string(), name: z.string() }),
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', name: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
