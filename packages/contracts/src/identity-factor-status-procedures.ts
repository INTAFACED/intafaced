import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `factorStatus.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const kinds = z.object({
  platform: z.number().int(),
  cross_device: z.number().int(),
  security_key: z.number().int(),
  unknown: z.number().int(),
});

export const status = z.object({
  password: z.boolean(),
  authenticator: z.object({ on: z.boolean(), label: z.string().nullable() }),
  passkeys: z.object({ count: z.number().int(), kinds }),
  recoveryCodesLeft: z.number().int(),
  secondStepRequired: z.object({ floor: z.array(z.enum(['money_out', 'security_change'])), policy: z.null() }),
  checklist: z.array(z.object({ key: z.enum(['second_factor', 'passkey', 'authenticator', 'recovery_codes']), done: z.boolean() })),
});

export const IDENTITY_FACTOR_STATUS = defineProcedure({
  ...base,
  name: 'identity.factorStatus',
  kind: 'query',
  path: 'factorStatus',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: status,
  samples: [{ verdict: 'accept' }],
});
