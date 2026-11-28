import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  accountArchiveProposalsSchema,
  accountTierListSchema,
  customerDetailDecisionInputSchema,
  customerDetailsResultSchema,
  accountClosureLookupInputSchema,
  accountClosureStateSchema,
  customerDetailsHistoryInputSchema,
  accountTierLookupInputSchema,
  accountTierStateSchema,
  accountArchiveHistoryInputSchema,
  accountArchiveResultSchema,
  accountArchiveLookupInputSchema,
  accountArchiveStateSchema,
  accountLimitsHistoryInputSchema,
  accountLimitResultSchema,
  accountLimitsLookupInputSchema,
  accountLimitsStateSchema,
  accountControlLookupInputSchema,
  accountControlStateSchema,
  accountControlHistoryInputSchema,
  accountControlResultSchema,
  identityAccountControlInputSchema,
  accountLimitOverrideClearInputSchema,
  accountArchiveInputSchema,
  accountClosureInputSchema,
  accountClosureResultSchema,
  accountTierMoveInputSchema,
  accountTierResultSchema,
  accountClosureHistoryInputSchema,
  accountTierHistoryInputSchema,
  accountOperatorEntitlementSchema,
  accountLimitOverrideSetInputSchema,
} from './account-controls.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `accountControls.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_PROPOSALS = defineProcedure({
  ...base,
  name: 'identity.accountControls.archiveProposals',
  kind: 'query',
  path: 'accountControls.archiveProposals',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({}).strict(),
  output: accountArchiveProposalsSchema,
  outputChecks: { account_archive_proposals_holds: { at: 'output', says: 'No proposal without a dormancy period' } },
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_DETAILS_DECIDE = defineProcedure({
  ...base,
  name: 'identity.accountControls.detailsDecide',
  kind: 'mutation',
  path: 'accountControls.detailsDecide',
  access: { caller: 'signedIn' },
  refusals: {},
  input: customerDetailDecisionInputSchema,
  output: customerDetailsResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        reviewId: '11111111-1111-4111-8111-111111111111',
        decision: 'pass',
        note: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_TIERS = defineProcedure({
  ...base,
  name: 'identity.accountControls.tiers',
  kind: 'query',
  path: 'accountControls.tiers',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({}).strict(),
  output: accountTierListSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_CLOSURE_STATE = defineProcedure({
  ...base,
  name: 'identity.accountControls.closureState',
  kind: 'query',
  path: 'accountControls.closureState',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountClosureLookupInputSchema,
  output: accountClosureStateSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_DETAILS_HISTORY = defineProcedure({
  ...base,
  name: 'identity.accountControls.detailsHistory',
  kind: 'query',
  path: 'accountControls.detailsHistory',
  access: { caller: 'signedIn' },
  refusals: {},
  input: customerDetailsHistoryInputSchema,
  output: z.array(customerDetailsResultSchema),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_TIER_STATE = defineProcedure({
  ...base,
  name: 'identity.accountControls.tierState',
  kind: 'query',
  path: 'accountControls.tierState',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountTierLookupInputSchema,
  output: accountTierStateSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_HISTORY = defineProcedure({
  ...base,
  name: 'identity.accountControls.archiveHistory',
  kind: 'query',
  path: 'accountControls.archiveHistory',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountArchiveHistoryInputSchema,
  output: z.array(accountArchiveResultSchema),
  outputChecks: {
    account_archive_result_holds: {
      at: 'output[]',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different account; Outcome and archive state disagree',
    },
    account_archive_state_holds: {
      at: ['output[]|0.before', 'output[]|0.after', 'output[]|1.current', 'output[]|2.current'],
      says: 'Only a closed account is archived; An archive carries its reason code',
    },
  },
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_ARCHIVE_STATE = defineProcedure({
  ...base,
  name: 'identity.accountControls.archiveState',
  kind: 'query',
  path: 'accountControls.archiveState',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountArchiveLookupInputSchema,
  output: accountArchiveStateSchema.nullable(),
  outputChecks: {
    account_archive_state_holds: { at: 'output', says: 'Only a closed account is archived; An archive carries its reason code' },
  },
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_LIMITS_HISTORY = defineProcedure({
  ...base,
  name: 'identity.accountControls.limitsHistory',
  kind: 'query',
  path: 'accountControls.limitsHistory',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountLimitsHistoryInputSchema,
  output: z.array(accountLimitResultSchema),
  outputChecks: {
    account_limit_result_holds: {
      at: 'output[]',
      says: 'Unauthorized attempts cannot disclose target state; Override belongs to another account, rail or asset; The ceiling comes with limit_requires_approver only; Outcome, action and versions disagree',
    },
    account_limit_amount_holds: {
      at: [
        'output[]|0.before.perTx',
        'output[]|0.before.rolling24h',
        'output[]|0.after.perTx',
        'output[]|0.after.rolling24h',
        'output[]|1.current.perTx',
        'output[]|1.current.rolling24h',
        'output[]|1.ceiling',
        'output[]|2.current.perTx',
        'output[]|2.current.rolling24h',
      ],
      says: 'A limit figure is above zero',
    },
  },
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_LIMITS = defineProcedure({
  ...base,
  name: 'identity.accountControls.limits',
  kind: 'query',
  path: 'accountControls.limits',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountLimitsLookupInputSchema,
  output: accountLimitsStateSchema.nullable(),
  outputChecks: {
    account_limits_state_holds: { at: 'output', says: 'An override belongs to another account' },
    account_limit_amount_holds: {
      at: ['output.overrides[].perTx', 'output.overrides[].rolling24h', 'output.policy|0.ceilings[].ceiling'],
      says: 'A limit figure is above zero',
    },
  },
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_GET_STATE = defineProcedure({
  ...base,
  name: 'identity.accountControls.getState',
  kind: 'query',
  path: 'accountControls.getState',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountControlLookupInputSchema.refine((input) => input.target.area === 'identity', 'Identity target required'),
  checks: { answer_holds: { at: 'input', says: 'Identity target required' } },
  output: accountControlStateSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { target: { area: 'identity', userId: '11111111-1111-4111-8111-111111111111' } } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'answer_holds', input: { target: { area: 'trading', userId: '11111111-1111-4111-8111-111111111111' } } },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_HISTORY = defineProcedure({
  ...base,
  name: 'identity.accountControls.history',
  kind: 'query',
  path: 'accountControls.history',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountControlHistoryInputSchema.refine((input) => input.target.area === 'identity', 'Identity target required'),
  checks: { answer_holds: { at: 'input', says: 'Identity target required' } },
  output: z.array(accountControlResultSchema),
  outputChecks: {
    account_control_result_holds: {
      at: 'output[]',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different target; Outcome, action and state versions disagree',
    },
  },
  samples: [
    { verdict: 'accept', input: { target: { area: 'identity', userId: '11111111-1111-4111-8111-111111111111' }, limit: 1 } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'answer_holds',
      input: { target: { area: 'trading', userId: '11111111-1111-4111-8111-111111111111' }, limit: 1 },
    },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_CHANGE = defineProcedure({
  ...base,
  name: 'identity.accountControls.change',
  kind: 'mutation',
  path: 'accountControls.change',
  access: { caller: 'signedIn' },
  refusals: {},
  input: identityAccountControlInputSchema.refine(
    (input) => input.target.area === 'identity' || input.target.area === 'trading',
    'Identity or trading target required',
  ),
  checks: { answer_holds: { at: 'input', says: 'Identity or trading target required' } },
  output: accountControlResultSchema,
  outputChecks: {
    account_control_result_holds: {
      at: 'output',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different target; Outcome, action and state versions disagree',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        target: { area: 'identity', userId: '11111111-1111-4111-8111-111111111111' },
        action: 'restrict',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'answer_holds',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        target: { area: 'merchant', merchantId: '11111111-1111-4111-8111-111111111111' },
        action: 'restrict',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_LIMITS_CLEAR = defineProcedure({
  ...base,
  name: 'identity.accountControls.limitsClear',
  kind: 'mutation',
  path: 'accountControls.limitsClear',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountLimitOverrideClearInputSchema,
  output: accountLimitResultSchema,
  outputChecks: {
    account_limit_result_holds: {
      at: 'output',
      says: 'Unauthorized attempts cannot disclose target state; Override belongs to another account, rail or asset; The ceiling comes with limit_requires_approver only; Outcome, action and versions disagree',
    },
    account_limit_amount_holds: {
      at: [
        'output|0.before.perTx',
        'output|0.before.rolling24h',
        'output|0.after.perTx',
        'output|0.after.rolling24h',
        'output|1.current.perTx',
        'output|1.current.rolling24h',
        'output|1.ceiling',
        'output|2.current.perTx',
        'output|2.current.rolling24h',
      ],
      says: 'A limit figure is above zero',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        rail: 'withdrawal',
        assetId: 'USDC',
        reason: '11111111-1111-4111-8111-111111111111',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_ARCHIVE = defineProcedure({
  ...base,
  name: 'identity.accountControls.archive',
  kind: 'mutation',
  path: 'accountControls.archive',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountArchiveInputSchema,
  output: accountArchiveResultSchema,
  outputChecks: {
    account_archive_result_holds: {
      at: 'output',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different account; Outcome and archive state disagree',
    },
    account_archive_state_holds: {
      at: ['output|0.before', 'output|0.after', 'output|1.current', 'output|2.current'],
      says: 'Only a closed account is archived; An archive carries its reason code',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        reasonCode: 'dormant',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_CLOSURE = defineProcedure({
  ...base,
  name: 'identity.accountControls.closure',
  kind: 'mutation',
  path: 'accountControls.closure',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountClosureInputSchema,
  output: accountClosureResultSchema,
  outputChecks: {
    account_closure_result_holds: {
      at: 'output',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different account; Outcome, action and state versions disagree; A close carries a reason code and a reopen does not',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        action: 'close',
        reasonCode: 'fraud',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_TIER_MOVE = defineProcedure({
  ...base,
  name: 'identity.accountControls.tierMove',
  kind: 'mutation',
  path: 'accountControls.tierMove',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountTierMoveInputSchema,
  output: accountTierResultSchema,
  outputChecks: {
    account_tier_result_holds: {
      at: 'output',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different account; Blank terms come with tier_terms_unset only; Outcome, tier and state versions disagree',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        tierId: 'x',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_CLOSURE_HISTORY = defineProcedure({
  ...base,
  name: 'identity.accountControls.closureHistory',
  kind: 'query',
  path: 'accountControls.closureHistory',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountClosureHistoryInputSchema,
  output: z.array(accountClosureResultSchema),
  outputChecks: {
    account_closure_result_holds: {
      at: 'output[]',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different account; Outcome, action and state versions disagree; A close carries a reason code and a reopen does not',
    },
  },
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_TIER_HISTORY = defineProcedure({
  ...base,
  name: 'identity.accountControls.tierHistory',
  kind: 'query',
  path: 'accountControls.tierHistory',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountTierHistoryInputSchema,
  output: z.array(accountTierResultSchema),
  outputChecks: {
    account_tier_result_holds: {
      at: 'output[]',
      says: 'Unauthorized attempts cannot disclose target state; State belongs to a different account; Blank terms come with tier_terms_unset only; Outcome, tier and state versions disagree',
    },
  },
  samples: [
    { verdict: 'accept', input: { userId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_OPERATOR_STATUS = defineProcedure({
  ...base,
  name: 'identity.accountControls.operatorStatus',
  kind: 'query',
  path: 'accountControls.operatorStatus',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({}).strict(),
  output: accountOperatorEntitlementSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_CONTROLS_LIMITS_SET = defineProcedure({
  ...base,
  name: 'identity.accountControls.limitsSet',
  kind: 'mutation',
  path: 'accountControls.limitsSet',
  access: { caller: 'signedIn' },
  refusals: {},
  input: accountLimitOverrideSetInputSchema,
  checks: {
    account_limit_override_set_input_holds: { at: 'input', says: 'An override sets at least one figure' },
    account_limit_amount_holds: { at: ['input.perTx', 'input.rolling24h'], says: 'A limit figure is above zero' },
  },
  output: accountLimitResultSchema,
  outputChecks: {
    account_limit_result_holds: {
      at: 'output',
      says: 'Unauthorized attempts cannot disclose target state; Override belongs to another account, rail or asset; The ceiling comes with limit_requires_approver only; Outcome, action and versions disagree',
    },
    account_limit_amount_holds: {
      at: [
        'output|0.before.perTx',
        'output|0.before.rolling24h',
        'output|0.after.perTx',
        'output|0.after.rolling24h',
        'output|1.current.perTx',
        'output|1.current.rolling24h',
        'output|1.ceiling',
        'output|2.current.perTx',
        'output|2.current.rolling24h',
      ],
      says: 'A limit figure is above zero',
    },
  },
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        rail: 'withdrawal',
        assetId: 'A',
        perTx: '1',
        rolling24h: '1',
        expiresAt: '2026-01-01T00:00:00.000Z',
        reason: '11111111-1111-4111-8111-111111111111',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'account_limit_override_set_input_holds',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        rail: 'withdrawal',
        assetId: 'A',
        perTx: null,
        rolling24h: null,
        expiresAt: '2026-01-01T00:00:00.000Z',
        reason: '11111111-1111-4111-8111-111111111111',
        expectedVersion: '1',
      },
    },
    {
      verdict: 'refuse',
      by: 'account_limit_amount_holds',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        rail: 'withdrawal',
        assetId: 'A',
        perTx: '0',
        rolling24h: '1',
        expiresAt: '2026-01-01T00:00:00.000Z',
        reason: '11111111-1111-4111-8111-111111111111',
        expectedVersion: '1',
      },
    },
  ],
});
