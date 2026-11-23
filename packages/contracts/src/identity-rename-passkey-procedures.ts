import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { row } from './identity-list-passkeys-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_RENAME_PASSKEY = defineProcedure({
  ...base,
  name: 'identity.renamePasskey',
  kind: 'mutation',
  path: 'renamePasskey',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z
    .object({
      credentialId: z.string().min(1).max(1024),
      label: z.string().max(256),
      clientRequestId: z.string().min(1).max(128),
      stepUpApprovalId: z.string().min(1).max(128).nullish(),
    })
    .strict(),
  output: row,
  samples: [
    { verdict: 'accept', input: { credentialId: 'placeholder', label: 'USDC', clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
