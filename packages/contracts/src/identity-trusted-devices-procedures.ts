import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { iso } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `trustedDevices.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_TRUSTED_DEVICES_LIST = defineProcedure({
  ...base,
  name: 'identity.trustedDevices.list',
  kind: 'query',
  path: 'trustedDevices.list',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z
    .object({
      check: z.enum(['on', 'off']),
      devices: z.array(
        z
          .object({
            id: z.string().guid(),
            label: z.string(),
            firstSeenAt: iso,
            lastSeenAt: iso,
            trustedUntil: iso.nullable(),
            current: z.boolean(),
            newSignIn: z.boolean(),
          })
          .strict(),
      ),
      waiting: z.array(z.object({ flowId: z.string().guid(), label: z.string(), createdAt: iso, expiresAt: iso }).strict()),
    })
    .strict(),
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_TRUSTED_DEVICES_REMOVE = defineProcedure({
  ...base,
  name: 'identity.trustedDevices.remove',
  kind: 'mutation',
  path: 'trustedDevices.remove',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z
    .object({
      deviceId: z.string().guid(),
      clientRequestId: z.string().min(1).max(128),
      stepUpApprovalId: z.string().min(1).max(128).nullish(),
    })
    .strict(),
  output: z.object({ removed: z.boolean(), sessionsEnded: z.number().int().nonnegative() }).strict(),
  samples: [
    { verdict: 'accept', input: { deviceId: '11111111-1111-4111-8111-111111111111', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_TRUSTED_DEVICES_APPROVE = defineProcedure({
  ...base,
  name: 'identity.trustedDevices.approve',
  kind: 'mutation',
  path: 'trustedDevices.approve',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ flowId: z.string().guid(), stepUpApprovalId: z.string().min(1).max(128).nullish() }).strict(),
  output: z.object({ approved: z.literal(true) }).strict(),
  samples: [
    { verdict: 'accept', input: { flowId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_TRUSTED_DEVICES_CONFIRM_SIGN_IN = defineProcedure({
  ...base,
  name: 'identity.trustedDevices.confirmSignIn',
  kind: 'mutation',
  path: 'trustedDevices.confirmSignIn',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ deviceId: z.string().guid() }).strict(),
  output: z.object({ confirmed: z.number().int().nonnegative() }).strict(),
  samples: [
    { verdict: 'accept', input: { deviceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
