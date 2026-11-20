import { z } from 'zod';
import {
  PAY_ALLOWLIST_CHANGE_STATUSES,
  payAllowlistChangeSchema,
  payAllowlistEntrySchema,
  payAllowlistModeSchema,
  payAllowlistPolicySchema,
  payAllowlistSetModeResultSchema,
} from './pay-money-room.js';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-pay `allowlist.*`: the customer's and the approver's side of the withdrawal allowlist, one record per call. The list
 * says where money MAY go; it is not a balance and moves nothing. Changing the list, the mode or the one-time policy takes
 * `trade:withdraw` (interactive, step-up), cancelling one's own waiting change `trade:write`, reading `trade:read`; the
 * caller is always the token's user. Every input is strict and has no default. svc-pay mounts each from here
 * (`withdrawals/allowlist/router.ts`) and the customer app calls each by its record.
 */

export const ALLOWLIST_GROUPS = ['internal_wallet', 'external_wallet', 'contract'] as const;

/** 1 to 18 decimal places with a digit other than 0: the zeros before the first other digit, then up to 18 in all. */
const nonZeroPlaces = Array.from({ length: 18 }, (_, zeros) => `0{${zeros}}[1-9]\\d{0,${17 - zeros}}`).join('|');
/** A positive unsigned decimal string with at most 18 places: a whole part with a digit other than 0, or such places. */
const amount = z
  .string()
  .regex(
    new RegExp(`^(\\d*[1-9]\\d*(\\.\\d{1,18})?|\\d+\\.(${nonZeroPlaces}))$`),
    'amounts are positive unsigned decimal strings with at most 18 decimal places',
  );
const assetId = z.string().min(1).max(32);
const id = z.string().guid();
const limit = z.number().int().min(1).max(200);
const clientRef = z.string().min(1).max(64);
/** A page: `limit` is optional so a missing one reaches `allowlist.list_limit_unset`, never a default. */
const page = z.object({ limit: limit.optional(), after: id.optional() }).strict();
const byChange = z.object({ changeId: id }).strict();
/** The approver names the hash of the change they looked at, so an approval can never ride a different change. */
const decide = z.object({ changeId: id, requestHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/** Each refusal by its code, with the status svc-pay's allowlist error table sends it with (`withdrawals/allowlist/errors.ts`). */
const STATUS = {
  'allowlist.quorum_unset': 'PRECONDITION_FAILED',
  'allowlist.conflict': 'CONFLICT',
  'allowlist.not_found': 'NOT_FOUND',
  'allowlist.not_waiting': 'CONFLICT',
  'allowlist.hash_mismatch': 'CONFLICT',
  'allowlist.requester_cannot_approve': 'FORBIDDEN',
  'allowlist.approver_not_eligible': 'FORBIDDEN',
  'allowlist.eligibility_unavailable': 'SERVICE_UNAVAILABLE',
  'allowlist.eligibility_unwired': 'PRECONDITION_FAILED',
  'allowlist.address_invalid': 'BAD_REQUEST',
  'allowlist.address_listed': 'CONFLICT',
  'allowlist.label_taken': 'CONFLICT',
  'allowlist.entry_not_found': 'NOT_FOUND',
  'allowlist.mode_already_off': 'CONFLICT',
  'allowlist.policy_unchanged': 'CONFLICT',
  'allowlist.list_limit_unset': 'BAD_REQUEST',
} as const satisfies Record<string, RefusalStatus>;
type Code = keyof typeof STATUS;
const refuse = (...codes: Code[]): Refusals => Object.freeze(Object.fromEntries(codes.map((c) => [c, STATUS[c]])));

/** Filing a change: a reference naming a different change, no quorum set, or the change unreadable after it was filed. */
const SUBMIT = ['allowlist.conflict', 'allowlist.quorum_unset', 'allowlist.not_found'] as const;
/** Deciding one: it exists, the decider is not its requester, read the same change, and may approve for the team. */
const DECIDE = [
  'allowlist.not_found',
  'allowlist.not_waiting',
  'allowlist.requester_cannot_approve',
  'allowlist.hash_mismatch',
  'allowlist.eligibility_unwired',
  'allowlist.eligibility_unavailable',
  'allowlist.approver_not_eligible',
] as const;

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'ledger' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'ledger' } as const;
const WITHDRAW = { caller: 'scope', scope: 'trade:withdraw', module: 'ledger' } as const;
const CHANGE_ID = '33333333-3333-4333-8333-333333333333';
const TEAM_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);

export const PAY_ALLOWLIST_MODE = defineProcedure({
  ...base,
  name: 'pay.allowlist.mode',
  kind: 'query',
  path: 'allowlist.mode',
  access: READ,
  refusals: refuse(),
  input: z.object({}).strict(),
  output: payAllowlistModeSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { userId: CHANGE_ID } },
  ],
});

export const PAY_ALLOWLIST_POLICY = defineProcedure({
  ...base,
  name: 'pay.allowlist.policy',
  kind: 'query',
  path: 'allowlist.policy',
  access: READ,
  refusals: refuse(),
  input: z.object({}).strict(),
  output: payAllowlistPolicySchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { userId: CHANGE_ID } },
  ],
});

export const PAY_ALLOWLIST_SET_MODE = defineProcedure({
  ...base,
  name: 'pay.allowlist.setMode',
  kind: 'mutation',
  path: 'allowlist.setMode',
  access: WITHDRAW,
  // ON applies at once and needs a quorum; OFF is a change filed for the team.
  refusals: refuse(...SUBMIT, 'allowlist.mode_already_off'),
  input: z.object({ enabled: z.boolean(), clientRef }).strict(),
  output: payAllowlistSetModeResultSchema,
  samples: [
    { verdict: 'accept', input: { enabled: false, clientRef: 'mode-off-1' } },
    { verdict: 'refuse', input: { enabled: true } },
    { verdict: 'refuse', input: { enabled: 'yes', clientRef: 'mode-on-1' } },
  ],
});

export const PAY_ALLOWLIST_PROPOSE_POLICY = defineProcedure({
  ...base,
  name: 'pay.allowlist.proposePolicy',
  kind: 'mutation',
  path: 'allowlist.proposePolicy',
  access: WITHDRAW,
  refusals: refuse(...SUBMIT, 'allowlist.policy_unchanged'),
  input: z
    .object({
      enabled: z.boolean(),
      assetId,
      /** One one-time send of this asset may be up to this amount. */
      maxAmount: amount,
      clientRef,
    })
    .strict(),
  output: payAllowlistChangeSchema,
  samples: [
    { verdict: 'accept', input: { enabled: true, assetId: 'USDC', maxAmount: '250.5', clientRef: 'policy-1' } },
    { verdict: 'refuse', input: { enabled: true, assetId: 'USDC', maxAmount: '0', clientRef: 'policy-1' } },
    { verdict: 'refuse', input: { enabled: true, assetId: 'USDC', maxAmount: '-5', clientRef: 'policy-1' } },
  ],
});

export const PAY_ALLOWLIST_PROPOSE_ADD = defineProcedure({
  ...base,
  name: 'pay.allowlist.proposeAdd',
  kind: 'mutation',
  path: 'allowlist.proposeAdd',
  access: WITHDRAW,
  refusals: refuse(...SUBMIT, 'allowlist.address_invalid', 'allowlist.address_listed', 'allowlist.label_taken'),
  input: z
    .object({
      group: z.enum(ALLOWLIST_GROUPS),
      assetId,
      address: z.string().min(1).max(128),
      label: z.string().min(1).max(64),
      clientRef,
    })
    .strict(),
  output: payAllowlistChangeSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        group: 'external_wallet',
        assetId: 'USDC',
        address: '0x1111111111111111111111111111111111111111',
        label: 'Cold wallet',
        clientRef: 'add-1',
      },
    },
    {
      verdict: 'refuse',
      input: { group: 'bank', assetId: 'USDC', address: '0x1111111111111111111111111111111111111111', label: 'x', clientRef: 'add-1' },
    },
    { verdict: 'refuse', input: { group: 'contract', assetId: 'USDC', address: '', label: 'x', clientRef: 'add-1' } },
  ],
});

export const PAY_ALLOWLIST_PROPOSE_DELETE = defineProcedure({
  ...base,
  name: 'pay.allowlist.proposeDelete',
  kind: 'mutation',
  path: 'allowlist.proposeDelete',
  access: WITHDRAW,
  refusals: refuse(...SUBMIT, 'allowlist.entry_not_found'),
  input: z.object({ entryId: id, clientRef }).strict(),
  output: payAllowlistChangeSchema,
  samples: [
    { verdict: 'accept', input: { entryId: CHANGE_ID, clientRef: 'delete-1' } },
    { verdict: 'refuse', input: { entryId: 'not-an-entry', clientRef: 'delete-1' } },
  ],
});

export const PAY_ALLOWLIST_APPROVE = defineProcedure({
  ...base,
  name: 'pay.allowlist.approve',
  kind: 'mutation',
  path: 'allowlist.approve',
  access: WITHDRAW,
  refusals: refuse(...DECIDE),
  input: decide,
  output: payAllowlistChangeSchema,
  samples: [
    { verdict: 'accept', input: { changeId: CHANGE_ID, requestHash: HASH } },
    { verdict: 'refuse', input: { changeId: CHANGE_ID, requestHash: 'abc' } },
  ],
});

export const PAY_ALLOWLIST_REJECT = defineProcedure({
  ...base,
  name: 'pay.allowlist.reject',
  kind: 'mutation',
  path: 'allowlist.reject',
  access: WITHDRAW,
  refusals: refuse(...DECIDE),
  input: decide,
  output: payAllowlistChangeSchema,
  samples: [
    { verdict: 'accept', input: { changeId: CHANGE_ID, requestHash: HASH } },
    { verdict: 'refuse', input: { changeId: CHANGE_ID } },
  ],
});

export const PAY_ALLOWLIST_CANCEL = defineProcedure({
  ...base,
  name: 'pay.allowlist.cancel',
  kind: 'mutation',
  path: 'allowlist.cancel',
  access: WRITE,
  // Another person's change reads as one that does not exist.
  refusals: refuse('allowlist.not_found', 'allowlist.not_waiting'),
  input: byChange,
  output: payAllowlistChangeSchema,
  samples: [
    { verdict: 'accept', input: { changeId: CHANGE_ID } },
    { verdict: 'refuse', input: {} },
  ],
});

export const PAY_ALLOWLIST_GET = defineProcedure({
  ...base,
  name: 'pay.allowlist.get',
  kind: 'query',
  path: 'allowlist.get',
  access: READ,
  // Readable by its requester and an eligible approver of its team; anyone else is told it does not exist.
  refusals: refuse('allowlist.not_found'),
  input: byChange,
  output: payAllowlistChangeSchema,
  samples: [
    { verdict: 'accept', input: { changeId: CHANGE_ID } },
    { verdict: 'refuse', input: { changeId: CHANGE_ID, extra: true } },
  ],
});

export const PAY_ALLOWLIST_LIST_ENTRIES = defineProcedure({
  ...base,
  name: 'pay.allowlist.listEntries',
  kind: 'query',
  path: 'allowlist.listEntries',
  access: READ,
  refusals: refuse('allowlist.list_limit_unset'),
  input: page,
  output: z.array(payAllowlistEntrySchema),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'accept', input: { limit: 200, after: CHANGE_ID } },
    { verdict: 'refuse', input: { limit: 201 } },
  ],
});

export const PAY_ALLOWLIST_LIST_CHANGES = defineProcedure({
  ...base,
  name: 'pay.allowlist.listChanges',
  kind: 'query',
  path: 'allowlist.listChanges',
  access: READ,
  refusals: refuse('allowlist.list_limit_unset'),
  input: page,
  output: z.array(payAllowlistChangeSchema),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const PAY_ALLOWLIST_LIST_FOR_TEAM = defineProcedure({
  ...base,
  name: 'pay.allowlist.listForTeam',
  kind: 'query',
  path: 'allowlist.listForTeam',
  access: READ,
  refusals: refuse(
    'allowlist.list_limit_unset',
    'allowlist.eligibility_unwired',
    'allowlist.eligibility_unavailable',
    'allowlist.approver_not_eligible',
  ),
  input: z
    .object({ teamAccountId: id, status: z.enum(PAY_ALLOWLIST_CHANGE_STATUSES).optional(), limit: limit.optional(), after: id.optional() })
    .strict(),
  output: z.array(payAllowlistChangeSchema),
  samples: [
    { verdict: 'accept', input: { teamAccountId: TEAM_ID, status: 'waiting', limit: 20 } },
    { verdict: 'refuse', input: { teamAccountId: TEAM_ID, status: 'pending', limit: 20 } },
  ],
});

export const PAY_ALLOWLIST_PROCEDURES = [
  PAY_ALLOWLIST_MODE,
  PAY_ALLOWLIST_POLICY,
  PAY_ALLOWLIST_SET_MODE,
  PAY_ALLOWLIST_PROPOSE_POLICY,
  PAY_ALLOWLIST_PROPOSE_ADD,
  PAY_ALLOWLIST_PROPOSE_DELETE,
  PAY_ALLOWLIST_APPROVE,
  PAY_ALLOWLIST_REJECT,
  PAY_ALLOWLIST_CANCEL,
  PAY_ALLOWLIST_GET,
  PAY_ALLOWLIST_LIST_ENTRIES,
  PAY_ALLOWLIST_LIST_CHANGES,
  PAY_ALLOWLIST_LIST_FOR_TEAM,
] as const;
