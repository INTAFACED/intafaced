import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { areaSchema, grantView, permissionEventView } from './pay-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `submerchantPermission.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

/**
 * The area vocabulary, so a console does not hard-code its own copy.
 *
 * A second list in a UI is a list that goes stale, and a stale one renders
 * a checkbox for an area nothing enforces. `pay:read` rather than public:
 * the areas describe what this platform lets a facilitator delegate, which
 * is not something an anonymous caller needs.
 */
export const PAY_SUBMERCHANT_PERMISSION_AREAS = defineProcedure({
  ...base,
  name: 'pay.submerchantPermission.areas',
  kind: 'query',
  path: 'submerchantPermission.areas',
  access: { caller: 'scope', scope: 'pay:read', module: 'pay' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(areaSchema),
  samples: [{ verdict: 'accept' }],
});

/** The live grants over one node. Implicit authority is not listed — it is not a grant. */
export const PAY_SUBMERCHANT_PERMISSION_LIST = defineProcedure({
  ...base,
  name: 'pay.submerchantPermission.list',
  kind: 'query',
  path: 'submerchantPermission.list',
  access: { caller: 'scope', scope: 'pay:read', module: 'pay' },
  refusals: {},
  input: z.object({
    subjectMerchantId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `pay.submerchant_permission_list_limit_unset`.
     * Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(grantView),
  samples: [
    { verdict: 'accept', input: { subjectMerchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Grants AND revokes, newest first — the answer to "who could do this, and when". */
export const PAY_SUBMERCHANT_PERMISSION_HISTORY = defineProcedure({
  ...base,
  name: 'pay.submerchantPermission.history',
  kind: 'query',
  path: 'submerchantPermission.history',
  access: { caller: 'scope', scope: 'pay:read', module: 'pay' },
  refusals: {},
  input: z.object({
    subjectMerchantId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `pay.submerchant_permission_history_limit_unset`.
     * Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(permissionEventView),
  samples: [
    { verdict: 'accept', input: { subjectMerchantId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

const permissionChangeInput = z.object({
  granteeMerchantId: z.string().guid(),
  subjectMerchantId: z.string().guid(),
  area: areaSchema,
  /** `min(3)`: one character satisfies "not blank" and answers nothing. */
  reason: z.string().trim().min(3).max(500),
});
const permissionChangeSamples = [
  {
    verdict: 'accept',
    input: {
      granteeMerchantId: '11111111-1111-4111-8111-111111111111',
      subjectMerchantId: '22222222-2222-4222-8222-222222222222',
      area: 'payment',
      reason: 'Runs refunds for this shop',
    },
  },
  { verdict: 'refuse', input: 42 },
] as const;

/**
 * Delegate an area the caller already holds to a node between them and the subject. `reason` is required and stored:
 * a permission is what a later incident is reconstructed from.
 */
export const PAY_SUBMERCHANT_PERMISSION_GRANT = defineProcedure({
  ...base,
  name: 'pay.submerchantPermission.grant',
  kind: 'mutation',
  path: 'submerchantPermission.grant',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: permissionChangeInput,
  output: permissionEventView,
  samples: permissionChangeSamples,
});

/** Take it back: a new journal row, never an edit. Same authority as `grant`. */
export const PAY_SUBMERCHANT_PERMISSION_REVOKE = defineProcedure({
  ...base,
  name: 'pay.submerchantPermission.revoke',
  kind: 'mutation',
  path: 'submerchantPermission.revoke',
  access: { caller: 'scope', scope: 'pay:write', module: 'pay' },
  refusals: {},
  input: permissionChangeInput,
  output: permissionEventView,
  samples: permissionChangeSamples,
});
