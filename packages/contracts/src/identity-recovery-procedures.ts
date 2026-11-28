import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { recoveryViewSchema, RECOVERY_KEY_KINDS, RECOVERY_LABEL_MAX, recoveryPublicJwkSchema } from './identity-recovery.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `recovery.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const clientRequestId = z.string().min(1).max(128);

export const stepUpApprovalId = z.string().min(1).max(128).nullish();

export const IDENTITY_RECOVERY_KEYS_LIST = defineProcedure({
  ...base,
  name: 'identity.recovery.keys.list',
  kind: 'query',
  path: 'recovery.keys.list',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: recoveryViewSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_RECOVERY_PLAN_SET = defineProcedure({
  ...base,
  name: 'identity.recovery.plan.set',
  kind: 'mutation',
  path: 'recovery.plan.set',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z
    .object({
      heirHandle: z.string().min(1).max(33),
      threshold: z.number().int().min(1).max(1000),
      clientRequestId,
      stepUpApprovalId,
    })
    .strict(),
  output: recoveryViewSchema,
  samples: [
    { verdict: 'accept', input: { heirHandle: 'USDC', threshold: 1, clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_RECOVERY_KEYS_REVOKE = defineProcedure({
  ...base,
  name: 'identity.recovery.keys.revoke',
  kind: 'mutation',
  path: 'recovery.keys.revoke',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ keyId: z.string().guid(), clientRequestId, stepUpApprovalId }).strict(),
  output: recoveryViewSchema,
  samples: [
    { verdict: 'accept', input: { keyId: '11111111-1111-4111-8111-111111111111', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const label = z
  .string()
  .trim()
  .min(1)
  .max(RECOVERY_LABEL_MAX)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001F\u007F]+$/);

export const IDENTITY_RECOVERY_KEYS_ADD = defineProcedure({
  ...base,
  name: 'identity.recovery.keys.add',
  kind: 'mutation',
  path: 'recovery.keys.add',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z
    .object({
      kind: z.enum(RECOVERY_KEY_KINDS),
      label,
      publicKey: recoveryPublicJwkSchema,
      clientRequestId,
      stepUpApprovalId,
    })
    .strict(),
  output: recoveryViewSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        kind: 'key',
        label: '^',
        publicKey: {
          kty: 'EC',
          crv: 'P-256',
          x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
        clientRequestId: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
