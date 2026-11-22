import { defineProcedure, NO_INPUT } from './procedure.js';
import { appealSchema, appealsMineSchema, appealSubmitInputSchema, appealSubmitSignedOutInputSchema } from './identity-appeals.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `accountAppeal.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_ACCOUNT_APPEAL_MINE = defineProcedure({
  ...base,
  name: 'identity.accountAppeal.mine',
  kind: 'query',
  path: 'accountAppeal.mine',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: appealsMineSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_ACCOUNT_APPEAL_SUBMIT = defineProcedure({
  ...base,
  name: 'identity.accountAppeal.submit',
  kind: 'mutation',
  path: 'accountAppeal.submit',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: appealSubmitInputSchema,
  output: appealSchema,
  samples: [
    { verdict: 'accept', input: { restriction: 'trading_restricted', text: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * A staff-frozen person cannot sign in, so their appeal is filed here, signed out: the sign-in name and password
 * prove the account exactly as sign-in does (lockout, one answer for an unknown name and a wrong password), and only
 * then is the state named.
 */
export const IDENTITY_ACCOUNT_APPEAL_SUBMIT_SIGNED_OUT = defineProcedure({
  ...base,
  name: 'identity.accountAppeal.submitSignedOut',
  kind: 'mutation',
  path: 'accountAppeal.submitSignedOut',
  access: { caller: 'public' },
  refusals: {},
  input: appealSubmitSignedOutInputSchema,
  output: appealSchema,
  samples: [
    { verdict: 'accept', input: { identifier: 'USDC', password: 'placeholder', text: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
