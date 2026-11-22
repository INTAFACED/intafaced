import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { approvalId, code, requestId, status } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `totpManage.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_TOTP_MANAGE_STATUS = defineProcedure({
  ...base,
  name: 'identity.totpManage.status',
  kind: 'query',
  path: 'totpManage.status',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: status,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_TOTP_MANAGE_REPLACE_START = defineProcedure({
  ...base,
  name: 'identity.totpManage.replaceStart',
  kind: 'mutation',
  path: 'totpManage.replaceStart',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ clientRequestId: requestId, stepUpApprovalId: approvalId }).strict().optional(),
  output: z.object({ secret: z.string(), uri: z.string() }),
  samples: [
    { verdict: 'accept', input: { clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_TOTP_MANAGE_DISABLE = defineProcedure({
  ...base,
  name: 'identity.totpManage.disable',
  kind: 'mutation',
  path: 'totpManage.disable',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ code, clientRequestId: requestId, stepUpApprovalId: approvalId }).strict(),
  output: z.object({ disabled: z.literal(true), recoveryCodeSpent: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { code: 'ethereum', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_TOTP_MANAGE_RENAME = defineProcedure({
  ...base,
  name: 'identity.totpManage.rename',
  kind: 'mutation',
  path: 'totpManage.rename',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ label: z.string().max(256) }).strict(),
  output: status,
  samples: [
    { verdict: 'accept', input: { label: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
