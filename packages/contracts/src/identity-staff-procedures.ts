import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  staffAcceptInputSchema,
  staffAcceptResultSchema,
  staffInvitationInputSchema,
  staffInvitationSchema,
  staffListSchema,
} from './identity-staff.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `staff.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_STAFF_ACCEPT_INVITE = defineProcedure({
  ...base,
  name: 'identity.staff.acceptInvite',
  kind: 'mutation',
  path: 'staff.acceptInvite',
  access: { caller: 'public' },
  refusals: {},
  input: staffAcceptInputSchema,
  output: staffAcceptResultSchema,
  samples: [
    { verdict: 'accept', input: { token: 'placeholder-invite-token-0000000000000000', password: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_STAFF_INVITATION = defineProcedure({
  ...base,
  name: 'identity.staff.invitation',
  kind: 'query',
  path: 'staff.invitation',
  access: { caller: 'public' },
  refusals: {},
  input: staffInvitationInputSchema,
  output: staffInvitationSchema,
  samples: [
    { verdict: 'accept', input: { token: 'placeholder-invite-token-0000000000000000' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_STAFF_LIST = defineProcedure({
  ...base,
  name: 'identity.staff.list',
  kind: 'query',
  path: 'staff.list',
  access: { caller: 'founder' },
  refusals: {},
  input: NO_INPUT,
  output: staffListSchema,
  samples: [{ verdict: 'accept' }],
});
