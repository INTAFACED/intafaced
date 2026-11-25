import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  compromiseMineOutputSchema,
  compromiseReportInputSchema,
  compromiseReportOutputSchema,
  compromiseReviewInputSchema,
  compromiseReviewOutputSchema,
  compromiseStartInputSchema,
  compromiseStartOutputSchema,
} from './identity-compromise.js';
import {
  safetyReadOutputSchema,
  setExtraControlsInputSchema,
  safetyChangeOutputSchema,
  clearExtraControlsInputSchema,
  setLocationConsentInputSchema,
} from './identity-safety.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `account.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_ACCOUNT_COMPROMISED_MARK_REVIEWED = defineProcedure({
  ...base,
  name: 'identity.account.compromised.markReviewed',
  kind: 'mutation',
  path: 'account.compromised.markReviewed',
  access: { caller: 'signedIn' },
  refusals: {},
  input: compromiseReviewInputSchema,
  output: compromiseReviewOutputSchema,
  samples: [
    { verdict: 'accept', input: { item: 'devices' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_COMPROMISED_MINE = defineProcedure({
  ...base,
  name: 'identity.account.compromised.mine',
  kind: 'query',
  path: 'account.compromised.mine',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: compromiseMineOutputSchema,
  samples: [{ verdict: 'accept' }],
});

/** Ends every session and key, freezes the account and opens one case; again while it is open, the same case. */
export const IDENTITY_ACCOUNT_COMPROMISED_START = defineProcedure({
  ...base,
  name: 'identity.account.compromised.start',
  kind: 'mutation',
  path: 'account.compromised.start',
  access: { caller: 'signedIn' },
  refusals: {},
  input: compromiseStartInputSchema,
  output: compromiseStartOutputSchema,
  samples: [
    { verdict: 'accept', input: { password: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_COMPROMISED_REPORT_STOLEN_FUNDS = defineProcedure({
  ...base,
  name: 'identity.account.compromised.reportStolenFunds',
  kind: 'mutation',
  path: 'account.compromised.reportStolenFunds',
  access: { caller: 'signedIn' },
  refusals: {},
  input: compromiseReportInputSchema,
  output: compromiseReportOutputSchema,
  samples: [
    { verdict: 'accept', input: { body: 'USDC', clientRequestId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_SAFETY_READ = defineProcedure({
  ...base,
  name: 'identity.account.safety.read',
  kind: 'query',
  path: 'account.safety.read',
  access: { caller: 'signedIn' },
  refusals: {},
  input: NO_INPUT,
  output: safetyReadOutputSchema,
  outputChecks: { allowance_amount_holds: { at: 'output.extraControls.allowance.amount', says: 'more than zero' } },
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_ACCOUNT_SAFETY_SET_EXTRA_CONTROLS = defineProcedure({
  ...base,
  name: 'identity.account.safety.setExtraControls',
  kind: 'mutation',
  path: 'account.safety.setExtraControls',
  access: { caller: 'signedIn' },
  refusals: {},
  input: setExtraControlsInputSchema,
  checks: { allowance_amount_holds: { at: 'input.allowance.amount', says: 'more than zero' } },
  output: safetyChangeOutputSchema,
  outputChecks: { allowance_amount_holds: { at: 'output.extraControls.allowance.amount', says: 'more than zero' } },
  samples: [
    { verdict: 'accept', input: { controls: [], allowance: { amount: '1', assetId: 'USDT' }, password: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'allowance_amount_holds',
      input: { controls: [], allowance: { amount: '0', assetId: 'USDT' }, password: 'placeholder' },
    },
  ],
});

export const IDENTITY_ACCOUNT_SAFETY_CLEAR_EXTRA_CONTROLS = defineProcedure({
  ...base,
  name: 'identity.account.safety.clearExtraControls',
  kind: 'mutation',
  path: 'account.safety.clearExtraControls',
  access: { caller: 'signedIn' },
  refusals: {},
  input: clearExtraControlsInputSchema,
  output: safetyChangeOutputSchema,
  outputChecks: { allowance_amount_holds: { at: 'output.extraControls.allowance.amount', says: 'more than zero' } },
  samples: [
    { verdict: 'accept', input: { password: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_ACCOUNT_SAFETY_SET_LOCATION_CONSENT = defineProcedure({
  ...base,
  name: 'identity.account.safety.setLocationConsent',
  kind: 'mutation',
  path: 'account.safety.setLocationConsent',
  access: { caller: 'signedIn' },
  refusals: {},
  input: setLocationConsentInputSchema,
  output: safetyChangeOutputSchema,
  outputChecks: { allowance_amount_holds: { at: 'output.extraControls.allowance.amount', says: 'more than zero' } },
  samples: [
    { verdict: 'accept', input: { consent: true } },
    { verdict: 'refuse', input: 42 },
  ],
});
