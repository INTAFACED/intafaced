import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  complianceCaseSchema,
  complianceCasesListInputSchema,
  complianceCasesListOutputSchema,
  complianceInboxEntrySchema,
  complianceInboxSchema,
  complianceQueueDefineInputSchema,
} from './ops-compliance-cases.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `compliance.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_COMPLIANCE_INBOXES_SET_FAVOURITE = defineProcedure({
  ...base,
  name: 'ops.compliance.inboxes.setFavourite',
  kind: 'mutation',
  path: 'compliance.inboxes.setFavourite',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'core-ops', plane: 'fiat' },
  refusals: { 'compliance.inbox_forbidden': 'FORBIDDEN' },
  input: z.object({ inboxId: z.string().min(1).max(128), favourite: z.boolean() }),
  output: z.object({ inboxId: z.string(), favourite: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { inboxId: 'USDC', favourite: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Defines a queue. The business key is `compliance:queue:<name>:<version>`: a repeat returns the stored definition. */
export const OPS_COMPLIANCE_INBOXES_DEFINE = defineProcedure({
  ...base,
  name: 'ops.compliance.inboxes.define',
  kind: 'mutation',
  path: 'compliance.inboxes.define',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {
    'compliance.inbox_forbidden': 'FORBIDDEN',
    'compliance.queue_entity_unknown': 'PRECONDITION_FAILED',
    'compliance.queue_name_taken': 'CONFLICT',
  },
  input: complianceQueueDefineInputSchema,
  output: complianceInboxSchema,
  samples: [
    { verdict: 'accept', input: { name: 'USDC', version: 1, entityType: 'USDC', workflow: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_COMPLIANCE_INBOXES_LIST = defineProcedure({
  ...base,
  name: 'ops.compliance.inboxes.list',
  kind: 'query',
  path: 'compliance.inboxes.list',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.compliance_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: NO_INPUT,
  output: z.object({ inboxes: z.array(complianceInboxEntrySchema) }),
  samples: [{ verdict: 'accept' }],
});

export const OPS_COMPLIANCE_CASES_LIST = defineProcedure({
  ...base,
  name: 'ops.compliance.cases.list',
  kind: 'query',
  path: 'compliance.cases.list',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'core-ops', plane: 'fiat' },
  refusals: { 'compliance.cases_list_limit_unset': 'PRECONDITION_FAILED', 'compliance.inbox_forbidden': 'FORBIDDEN' },
  input: complianceCasesListInputSchema,
  output: complianceCasesListOutputSchema,
  samples: [
    { verdict: 'accept', input: { inboxId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** For the access panel: who owns the inbox and whether the caller is a member. No rows, no count. */
export const OPS_COMPLIANCE_INBOXES_ACCESS = defineProcedure({
  ...base,
  name: 'ops.compliance.inboxes.access',
  kind: 'query',
  path: 'compliance.inboxes.access',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: z.object({ inboxId: z.string().min(1).max(128) }),
  output: z.object({ inboxId: z.string(), name: z.string(), owner: z.string(), member: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { inboxId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_COMPLIANCE_CASES_GET_BY_ID = defineProcedure({
  ...base,
  name: 'ops.compliance.cases.getById',
  kind: 'query',
  path: 'compliance.cases.getById',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'core-ops', plane: 'fiat' },
  refusals: { 'compliance.case_not_found': 'NOT_FOUND' },
  input: z.object({ id: z.string().trim().min(1).max(128) }),
  output: complianceCaseSchema,
  samples: [
    { verdict: 'accept', input: { id: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The next open, unassigned case of the inbox in stable order. Null is an honest empty, not an error. */
export const OPS_COMPLIANCE_CASES_NEXT = defineProcedure({
  ...base,
  name: 'ops.compliance.cases.next',
  kind: 'query',
  path: 'compliance.cases.next',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: z.object({ inboxId: z.string().min(1).max(128) }),
  output: z.object({ case: complianceCaseSchema.nullable() }),
  samples: [
    { verdict: 'accept', input: { inboxId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
