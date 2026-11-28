import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const orgRoleSchema = z.enum(['admin', 'trader', 'auditor', 'risk-manager']);

/** I-account-lifecycle-05: the caller's organisations. */
export const IDENTITY_LIST_ORGS = defineProcedure({
  ...base,
  name: 'identity.listOrgs',
  kind: 'query',
  path: 'listOrgs',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ orgs: z.array(z.object({ id: z.string().guid(), name: z.string(), role: orgRoleSchema, createdAt: z.string() })) }),
  samples: [{ verdict: 'accept' }],
});
