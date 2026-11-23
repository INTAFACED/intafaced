import { defineProcedure } from './procedure.js';
import { accountControlInputSchema, accountControlResultSchema, identityAccountControlInputSchema } from './account-controls.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `compliance.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const identityRestrictionInputSchema = accountControlInputSchema.refine(
  (input) => input.target.area === 'identity',
  'Identity target required',
);

export const identityFreezeInputSchema = identityRestrictionInputSchema.refine(
  (input) => input.action === 'restrict',
  'Restrict action required',
);

/** A restore carries the `identity.account_unfreeze` approval a second person signed (`approvalId`); identity spends it. */
export const identityRestoreInputSchema = identityAccountControlInputSchema
  .refine((input) => input.target.area === 'identity', 'Identity target required')
  .refine((input) => input.action === 'restore', 'Restore action required');

export const IDENTITY_COMPLIANCE_FREEZE_IDENTITY = defineProcedure({
  ...base,
  name: 'identity.compliance.freezeIdentity',
  kind: 'mutation',
  path: 'compliance.freezeIdentity',
  access: { caller: 'signedIn' },
  refusals: {},
  input: identityFreezeInputSchema,
  checks: { identity_freeze_input_holds: { at: ['input', 'input'], says: 'Restrict action required' } },
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
      by: 'identity_freeze_input_holds',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        target: { area: 'identity', userId: '11111111-1111-4111-8111-111111111111' },
        action: 'restore',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
  ],
});

export const IDENTITY_COMPLIANCE_UNFREEZE_IDENTITY = defineProcedure({
  ...base,
  name: 'identity.compliance.unfreezeIdentity',
  kind: 'mutation',
  path: 'compliance.unfreezeIdentity',
  access: { caller: 'signedIn' },
  refusals: {},
  input: identityRestoreInputSchema,
  checks: { identity_restore_input_holds: { at: ['input', 'input'], says: 'Restore action required; Identity target required' } },
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
        action: 'restore',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'identity_restore_input_holds',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        target: { area: 'identity', userId: '11111111-1111-4111-8111-111111111111' },
        action: 'restrict',
        reason: 'USDC',
        expectedVersion: '1',
      },
    },
  ],
});
