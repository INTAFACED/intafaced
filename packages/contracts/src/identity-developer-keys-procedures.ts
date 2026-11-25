import { z } from 'zod';
import {
  agentKeyApprovalListInputSchema,
  agentKeyApprovalListOutputSchema,
  agentKeyHoldInputSchema,
  agentKeyHoldOutputSchema,
  apiKeyCallRecordInputSchema,
  apiKeyCallRecordOutputSchema,
  apiKeyCallsInputSchema,
  apiKeyCallsOutputSchema,
  apiKeyDetailSchema,
  apiKeyGetInputSchema,
  apiKeyListInputSchema,
  apiKeyListOutputSchema,
  apiKeyRecordExact,
  apiKeyRevokeInputSchema,
  apiKeyRevokeOutputSchema,
  apiKeyScopesOutputSchema,
  developerSetRoleInputSchema,
  developerSetRoleOutputSchema,
  developerTeamInputSchema,
  developerTeamSchema,
  eachKeyOnce,
  type ApiKeyRecord,
} from './api-keys.js';
import { defineProcedure, NO_INPUT, type RefusalStatus } from './procedure.js';

/**
 * svc-identity's developer key doors (`developerKeys.*`), one record per call; the service mounts its whole router from
 * here (`services/svc-identity/src/developer-keys-router.ts`). Every person door refuses an API key or a sub-account
 * before anything is read (`identity.delegated_refused`, sent without a cause code); two doors are the edge's own.
 *
 * The four doors that take a fresh second factor (`create`, `setExpiry`, `rotate`, `approveRotation`) have no record yet:
 * a passkey assertion carries the browser's `clientExtensionResults`, any JSON, which the language-neutral export can't
 * say. They stay mounted by hand in the router until that shape has a record.
 */

/** How svc-identity sends each developer key refusal. */
export const DEVELOPER_KEY_REFUSALS = {
  'auth.scope_empty': 'BAD_REQUEST',
  'auth.scope_unknown': 'BAD_REQUEST',
  'auth.scope_interactive_only': 'FORBIDDEN',
  'auth.scope_not_held': 'FORBIDDEN',
  'auth.ip_invalid': 'BAD_REQUEST',
  'identity.key_name_invalid': 'BAD_REQUEST',
  'identity.key_name_taken': 'CONFLICT',
  'identity.key_expiry_invalid': 'BAD_REQUEST',
  'identity.key_cap_unset': 'PRECONDITION_FAILED',
  'identity.key_cap_reached': 'PRECONDITION_FAILED',
  'identity.key_request_conflict': 'CONFLICT',
  'identity.key_signing_unset': 'PRECONDITION_FAILED',
  'identity.key_lead_not_approved': 'FORBIDDEN',
  'identity.key_lead_check_unavailable': 'PRECONDITION_FAILED',
  'identity.key_not_found': 'NOT_FOUND',
  'identity.key_not_live': 'PRECONDITION_FAILED',
  'identity.key_revoke_reason_invalid': 'BAD_REQUEST',
  'identity.key_account_required': 'BAD_REQUEST',
  'identity.key_account_denied': 'FORBIDDEN',
  'identity.key_org_denied': 'FORBIDDEN',
  'identity.portfolio_key_cap_unset': 'PRECONDITION_FAILED',
  'identity.portfolio_key_cap_reached': 'PRECONDITION_FAILED',
  'auth.agent_scope_forbidden': 'FORBIDDEN',
  'identity.developer_roles_unset': 'PRECONDITION_FAILED',
  'identity.developer_role_read_only': 'FORBIDDEN',
  'identity.developer_role_none': 'FORBIDDEN',
  'identity.key_rotate_overlap_unset': 'PRECONDITION_FAILED',
  'identity.key_rotate_overlap_too_long': 'BAD_REQUEST',
  'identity.rate_limits_unset': 'PRECONDITION_FAILED',
} as const satisfies Record<string, RefusalStatus>;

/** How svc-identity sends each developer team refusal. */
export const DEVELOPER_TEAM_REFUSAL_STATUS = {
  'identity.developer_roles_unset': 'PRECONDITION_FAILED',
  'identity.developer_role_read_only': 'FORBIDDEN',
  'identity.developer_role_none': 'FORBIDDEN',
  'identity.developer_org_denied': 'NOT_FOUND',
  'identity.developer_role_denied': 'FORBIDDEN',
  'identity.developer_role_unknown': 'BAD_REQUEST',
  'identity.developer_member_unknown': 'NOT_FOUND',
  'identity.developer_request_conflict': 'CONFLICT',
} as const satisfies Record<string, RefusalStatus>;

/** The leaked-key desk: an operator with a second factor only. */
const LEAK_REFUSALS = { 'operator.denied': 'FORBIDDEN', 'mfa.required': 'FORBIDDEN' } as const satisfies Record<string, RefusalStatus>;

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'identity:read' } as const;
const WRITE = { caller: 'scope', scope: 'identity:write' } as const;
const COMPLIANCE = { caller: 'scope', scope: 'admin:compliance' } as const;
const EDGE = { caller: 'service', callers: ['svc-edge'] } as const;

const KEY = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';

/** A reply rule over the reply as `schema` reads it; a reply it can't read fails the rule. */
const replyHolds =
  <T>(schema: z.ZodType<T>, rule: (reply: T) => boolean) =>
  (reply: unknown): boolean => {
    const read = schema.safeParse(reply);
    return read.success && rule(read.data);
  };
/** Every key record in a reply is exact (real instants, a reason within its limit). */
const recordsExact = (records: readonly ApiKeyRecord[]): boolean => records.every(apiKeyRecordExact);
const EXACT_SAYS = 'each key record has real instants and a revoke reason of at most 200 code points';
const exactRecord = { says: EXACT_SAYS, holds: replyHolds(apiKeyRevokeOutputSchema, (reply) => recordsExact([reply.record])) };
const EXACT_INSTANT_SAYS = 'the instant is exactly what Date.toISOString writes for a real instant';

export const IDENTITY_DEVELOPER_KEYS_LIST = defineProcedure({
  ...base,
  name: 'identity.developerKeys.list',
  kind: 'query',
  path: 'developerKeys.list',
  access: READ,
  refusals: {},
  input: apiKeyListInputSchema,
  output: apiKeyListOutputSchema,
  accept: {
    eachKeyOnce: { says: 'each key appears once', holds: replyHolds(apiKeyListOutputSchema, (reply) => eachKeyOnce(reply.keys)) },
    exactRecords: { says: EXACT_SAYS, holds: replyHolds(apiKeyListOutputSchema, (reply) => recordsExact(reply.keys)) },
  },
  samples: [
    { verdict: 'accept', input: { limit: 200 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_GET = defineProcedure({
  ...base,
  name: 'identity.developerKeys.get',
  kind: 'query',
  path: 'developerKeys.get',
  access: READ,
  refusals: { 'identity.key_not_found': 'NOT_FOUND' },
  input: apiKeyGetInputSchema,
  output: apiKeyDetailSchema,
  accept: { exactRecord: { says: EXACT_SAYS, holds: replyHolds(apiKeyDetailSchema, (reply) => recordsExact([reply.key])) } },
  samples: [
    { verdict: 'accept', input: { keyId: KEY } },
    { verdict: 'refuse', input: { keyId: 'nope' } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_REVOKE = defineProcedure({
  ...base,
  name: 'identity.developerKeys.revoke',
  kind: 'mutation',
  path: 'developerKeys.revoke',
  access: WRITE,
  refusals: { ...DEVELOPER_KEY_REFUSALS, ...DEVELOPER_TEAM_REFUSAL_STATUS },
  checks: { reasonLength: { at: 'input.reason', says: 'the reason is at most 200 code points' } },
  input: apiKeyRevokeInputSchema,
  output: apiKeyRevokeOutputSchema,
  accept: { exactRecord },
  samples: [
    { verdict: 'accept', input: { keyId: KEY } },
    { verdict: 'accept', input: { keyId: KEY, orgId: ORG, reason: 'leaked' } },
    { verdict: 'refuse', input: { keyId: 'nope' } },
    { verdict: 'refuse', by: 'reasonLength', input: { keyId: KEY, reason: 'x'.repeat(201) } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_TEAM = defineProcedure({
  ...base,
  name: 'identity.developerKeys.team',
  kind: 'query',
  path: 'developerKeys.team',
  access: READ,
  refusals: DEVELOPER_TEAM_REFUSAL_STATUS,
  input: developerTeamInputSchema,
  output: developerTeamSchema,
  accept: { exactRecords: { says: EXACT_SAYS, holds: replyHolds(developerTeamSchema, (reply) => recordsExact(reply.keys)) } },
  samples: [
    { verdict: 'accept', input: { orgId: ORG } },
    { verdict: 'refuse', input: { orgId: 'nope' } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_SET_TEAM_ROLE = defineProcedure({
  ...base,
  name: 'identity.developerKeys.setTeamRole',
  kind: 'mutation',
  path: 'developerKeys.setTeamRole',
  access: WRITE,
  refusals: DEVELOPER_TEAM_REFUSAL_STATUS,
  input: developerSetRoleInputSchema,
  output: developerSetRoleOutputSchema,
  samples: [
    { verdict: 'accept', input: { orgId: ORG, userId: USER, role: 'keys_read', requestId: 'dev-role:sample' } },
    { verdict: 'accept', input: { orgId: ORG, userId: USER, role: null, requestId: 'dev-role:sample' } },
    { verdict: 'refuse', input: { orgId: ORG, userId: USER, role: 'owner', requestId: 'dev-role:sample' } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_REPORT_LEAKED = defineProcedure({
  ...base,
  name: 'identity.developerKeys.reportLeaked',
  kind: 'mutation',
  path: 'developerKeys.reportLeaked',
  access: COMPLIANCE,
  refusals: LEAK_REFUSALS,
  input: z.object({ key: z.string().min(1).max(512) }).strict(),
  output: z.object({ received: z.literal(true) }).strict(),
  samples: [
    { verdict: 'accept', input: { key: 'example' } },
    { verdict: 'refuse', input: { key: '' } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_OPERATOR_AUDIT = defineProcedure({
  ...base,
  name: 'identity.developerKeys.operatorAudit',
  kind: 'query',
  path: 'developerKeys.operatorAudit',
  access: COMPLIANCE,
  refusals: LEAK_REFUSALS,
  input: z.object({ keyId: z.string().guid(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  output: z.object({ entries: z.array(z.object({ actorId: z.string(), reason: z.string(), revokedAt: z.string() }).strict()) }).strict(),
  samples: [
    { verdict: 'accept', input: { keyId: KEY } },
    { verdict: 'refuse', input: { keyId: KEY, limit: 101 } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_ROTATION_REQUEST = defineProcedure({
  ...base,
  name: 'identity.developerKeys.rotationRequest',
  kind: 'query',
  path: 'developerKeys.rotationRequest',
  access: READ,
  refusals: {},
  input: z.object({ keyId: z.string().uuid() }),
  output: z.object({
    request: z.object({ requestId: z.string(), keyId: z.string(), overlapSeconds: z.number().int(), createdAt: z.string() }).nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { keyId: KEY } },
    { verdict: 'refuse', input: { keyId: 'nope' } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_SCOPES = defineProcedure({
  ...base,
  name: 'identity.developerKeys.scopes',
  kind: 'query',
  path: 'developerKeys.scopes',
  access: READ,
  refusals: {},
  input: NO_INPUT,
  output: apiKeyScopesOutputSchema,
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_DEVELOPER_KEYS_APPROVALS = defineProcedure({
  ...base,
  name: 'identity.developerKeys.approvals',
  kind: 'query',
  path: 'developerKeys.approvals',
  access: READ,
  refusals: {},
  input: agentKeyApprovalListInputSchema,
  output: agentKeyApprovalListOutputSchema,
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_CALLS = defineProcedure({
  ...base,
  name: 'identity.developerKeys.calls',
  kind: 'query',
  path: 'developerKeys.calls',
  access: READ,
  refusals: { 'identity.key_not_found': 'NOT_FOUND' },
  input: apiKeyCallsInputSchema,
  output: apiKeyCallsOutputSchema,
  samples: [
    { verdict: 'accept', input: { keyId: KEY, limit: 50 } },
    { verdict: 'accept', input: { keyId: KEY, limit: 50, status: 403, from: '2026-11-01', to: '2026-11-21' } },
    { verdict: 'refuse', input: { keyId: KEY, limit: 201 } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_RECORD_CALL = defineProcedure({
  ...base,
  name: 'identity.developerKeys.recordCall',
  kind: 'mutation',
  path: 'developerKeys.recordCall',
  access: EDGE,
  refusals: {},
  checks: { exactInstant: { at: 'input.at', says: EXACT_INSTANT_SAYS } },
  input: apiKeyCallRecordInputSchema,
  output: apiKeyCallRecordOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        keyHash: 'a'.repeat(64),
        requestId: 'req-1',
        method: 'GET',
        path: '/v1/orders',
        status: 200,
        clientIp: null,
        at: '2026-11-21T00:00:00.000Z',
      },
    },
    {
      verdict: 'refuse',
      input: {
        keyHash: 'nope',
        requestId: 'req-1',
        method: 'GET',
        path: '/v1/orders',
        status: 200,
        clientIp: null,
        at: '2026-11-21T00:00:00.000Z',
      },
    },
    {
      verdict: 'refuse',
      by: 'exactInstant',
      input: {
        keyHash: 'a'.repeat(64),
        requestId: 'req-1',
        method: 'GET',
        path: '/v1/orders',
        status: 200,
        clientIp: null,
        at: '2026-02-30T00:00:00.000Z',
      },
    },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_HOLD_AGENT_ACTION = defineProcedure({
  ...base,
  name: 'identity.developerKeys.holdAgentAction',
  kind: 'mutation',
  path: 'developerKeys.holdAgentAction',
  access: EDGE,
  refusals: { 'identity.key_not_found': 'NOT_FOUND' },
  input: agentKeyHoldInputSchema,
  output: agentKeyHoldOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        userId: USER,
        keyId: KEY,
        action: 'pay.payout',
        method: 'POST',
        path: '/v1/pay/payouts',
        bodyHash: `sha256:${'a'.repeat(64)}`,
      },
    },
    { verdict: 'refuse', input: { userId: USER, keyId: KEY, action: 'trade.order', method: 'POST', path: '/v1/x', bodyHash: 'sha256:x' } },
  ],
});

export const IDENTITY_DEVELOPER_KEYS_PROCEDURES = [
  IDENTITY_DEVELOPER_KEYS_LIST,
  IDENTITY_DEVELOPER_KEYS_GET,
  IDENTITY_DEVELOPER_KEYS_REVOKE,
  IDENTITY_DEVELOPER_KEYS_TEAM,
  IDENTITY_DEVELOPER_KEYS_SET_TEAM_ROLE,
  IDENTITY_DEVELOPER_KEYS_REPORT_LEAKED,
  IDENTITY_DEVELOPER_KEYS_OPERATOR_AUDIT,
  IDENTITY_DEVELOPER_KEYS_ROTATION_REQUEST,
  IDENTITY_DEVELOPER_KEYS_SCOPES,
  IDENTITY_DEVELOPER_KEYS_APPROVALS,
  IDENTITY_DEVELOPER_KEYS_CALLS,
  IDENTITY_DEVELOPER_KEYS_RECORD_CALL,
  IDENTITY_DEVELOPER_KEYS_HOLD_AGENT_ACTION,
] as const;
