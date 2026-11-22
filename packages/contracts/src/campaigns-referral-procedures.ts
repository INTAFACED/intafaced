import { defineProcedure } from './procedure.js';
import { myInviteesInputSchema, myInviteesSchema } from './campaigns-referral.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-campaigns `referral.*`, one record per call: svc-campaigns mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;

/**
 * The caller's own invitees (CM-referral-02): each one's place, when they joined, each step done or not and their
 * state, never who they are. The account is the signed principal's.
 */
export const CAMPAIGNS_REFERRAL_INVITEES = defineProcedure({
  ...base,
  name: 'campaigns.referral.invitees',
  kind: 'query',
  path: 'referral.invitees',
  access: { caller: 'scope', scope: 'campaigns:read', module: 'campaigns', plane: 'fiat' },
  refusals: {},
  input: myInviteesInputSchema,
  output: myInviteesSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
