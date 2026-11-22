import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `accountClosure.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const blocker = z.object({ code: z.string(), count: z.number().int() });

export const view = z.object({
  id: z.string().guid(),
  status: z.enum(['requested', 'cancelled', 'blocked', 'closed']),
  requestedAt: z.string(),
  effectiveAt: z.string(),
  finalizedAt: z.string().nullable(),
  clientRequestId: z.string(),
  blockers: z.array(blocker),
});

export const balance = z.object({ assetId: z.string(), amount: z.string() });

export const IDENTITY_ACCOUNT_CLOSURE_STATUS = defineProcedure({
  ...base,
  name: 'identity.accountClosure.status',
  kind: 'query',
  path: 'accountClosure.status',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ closure: view.nullable() }),
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_ACCOUNT_CLOSURE_CHECK = defineProcedure({
  ...base,
  name: 'identity.accountClosure.check',
  kind: 'query',
  path: 'accountClosure.check',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ blockers: z.array(blocker), balances: z.array(balance) }),
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_ACCOUNT_CLOSURE_REQUEST = defineProcedure({
  ...base,
  name: 'identity.accountClosure.request',
  kind: 'mutation',
  path: 'accountClosure.request',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ stepUpApprovalId: z.string().guid(), clientRequestId: z.string().guid() }).strict(),
  output: view,
  samples: [
    {
      verdict: 'accept',
      input: { stepUpApprovalId: '11111111-1111-4111-8111-111111111111', clientRequestId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CLOSURE_CANCEL = defineProcedure({
  ...base,
  name: 'identity.accountClosure.cancel',
  kind: 'mutation',
  path: 'accountClosure.cancel',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ stepUpApprovalId: z.string().guid() }).strict(),
  output: view,
  samples: [
    { verdict: 'accept', input: { stepUpApprovalId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
