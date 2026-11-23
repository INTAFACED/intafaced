import { defineProcedure } from './procedure.js';
import { identityLearnerCardInputSchema, identityLearnerCardResultSchema } from './identity-learner-card.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `learnerCard.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_LEARNER_CARD_LOOKUP = defineProcedure({
  ...base,
  name: 'identity.learnerCard.lookup',
  kind: 'query',
  path: 'learnerCard.lookup',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: identityLearnerCardInputSchema,
  output: identityLearnerCardResultSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
