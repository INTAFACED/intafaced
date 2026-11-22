import { defineProcedure, NO_INPUT } from './procedure.js';
import { supportMulePolicySchema, supportSafetyAcknowledgementsSchema } from './support-safety.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-support `safety.*`, one record per call: svc-support mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;

export const SUPPORT_SAFETY_MINE = defineProcedure({
  ...base,
  name: 'support.safety.mine',
  kind: 'query',
  path: 'safety.mine',
  access: { caller: 'scope', scope: 'support:read' },
  refusals: {},
  input: NO_INPUT,
  output: supportSafetyAcknowledgementsSchema,
  samples: [{ verdict: 'accept' }],
});

/** The owner's money-mule policy, or that none is published (public: the policy page reads it signed out too). */
export const SUPPORT_SAFETY_MULE_POLICY = defineProcedure({
  ...base,
  name: 'support.safety.mulePolicy',
  kind: 'query',
  path: 'safety.mulePolicy',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: supportMulePolicySchema,
  samples: [{ verdict: 'accept' }],
});
