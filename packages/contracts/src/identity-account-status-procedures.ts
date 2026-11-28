import { defineProcedure, NO_INPUT } from './procedure.js';
import { accountStatusSchema } from './identity-account-status.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `accountStatus.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_ACCOUNT_STATUS_MINE = defineProcedure({
  ...base,
  name: 'identity.accountStatus.mine',
  kind: 'query',
  path: 'accountStatus.mine',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: accountStatusSchema,
  samples: [{ verdict: 'accept' }],
});
