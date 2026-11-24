import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `selfFreezeManage.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_SELF_FREEZE_MANAGE_LIFT = defineProcedure({
  ...base,
  name: 'identity.selfFreezeManage.lift',
  kind: 'mutation',
  path: 'selfFreezeManage.lift',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ clientRequestId: z.string().min(1).max(128), stepUpApprovalId: z.string().min(1).max(128).nullish() }).strict(),
  output: z.object({ frozen: z.literal(false), changed: z.boolean(), liftedAt: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
