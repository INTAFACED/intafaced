import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { crmRetentionStatusSchema } from './crm-privacy.js';
import { crmWorkflowAuditListInputSchema, crmWorkflowAuditPageSchema } from './crm-workflows.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `outreach.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_OUTREACH_PRIVACY_RETENTION_STATUS = defineProcedure({
  ...base,
  name: 'ops.outreach.privacyRetentionStatus',
  kind: 'query',
  path: 'outreach.privacyRetentionStatus',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: NO_INPUT,
  output: crmRetentionStatusSchema,
  samples: [{ verdict: 'accept' }],
});

export const OPS_OUTREACH_OWNERS = defineProcedure({
  ...base,
  name: 'ops.outreach.owners',
  kind: 'query',
  path: 'outreach.owners',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: NO_INPUT,
  output: z
    .object({
      ownerUserIds: z.array(z.string().guid()).length(2),
      initialOwnerUserId: z.string().guid(),
      owners: z.tuple([
        z.object({ userId: z.string().guid(), displayName: z.literal('Nitro') }).strict(),
        z.object({ userId: z.string().guid(), displayName: z.literal('Phantom') }).strict(),
      ]),
    })
    .strict(),
  samples: [{ verdict: 'accept' }],
});

export const OPS_OUTREACH_LIST_WORKFLOW_AUDIT = defineProcedure({
  ...base,
  name: 'ops.outreach.listWorkflowAudit',
  kind: 'query',
  path: 'outreach.listWorkflowAudit',
  access: { caller: 'scope', scope: 'ops:read', check: 'authority' },
  refusals: {},
  input: crmWorkflowAuditListInputSchema,
  output: crmWorkflowAuditPageSchema,
  samples: [
    { verdict: 'accept', input: { subjectType: 'campaign', subjectId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
