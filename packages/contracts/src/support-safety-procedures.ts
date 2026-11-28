import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  supportMulePolicySchema,
  supportSafetyAcknowledgementsSchema,
  supportComplaintInputSchema,
  supportSafetyAcknowledgementSchema,
  supportBereavementInputSchema,
  supportScamReportInputSchema,
} from './support-safety.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-support `safety.*`, one record per call: svc-support mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-support', module: 'support', transport: 'trpc' } as const;

export const SUPPORT_SAFETY_MINE = defineProcedure({
  ...base,
  name: 'support.safety.mine',
  kind: 'query',
  path: 'safety.mine',
  access: { caller: 'scope', scope: 'support:read' },
  refusals: {},
  input: NO_INPUT,
  output: supportSafetyAcknowledgementsSchema,
  samples: [{ verdict: 'accept' }],
});

/** The owner's money-mule policy, or that none is published (public: the policy page reads it signed out too). */
export const SUPPORT_SAFETY_MULE_POLICY = defineProcedure({
  ...base,
  name: 'support.safety.mulePolicy',
  kind: 'query',
  path: 'safety.mulePolicy',
  access: { caller: 'public' },
  refusals: {},
  input: NO_INPUT,
  output: supportMulePolicySchema,
  samples: [{ verdict: 'accept' }],
});

export const SUPPORT_SAFETY_COMPLAIN = defineProcedure({
  ...base,
  name: 'support.safety.complain',
  kind: 'mutation',
  path: 'safety.complain',
  access: { caller: 'scope', scope: 'support:write' },
  refusals: {},
  input: supportComplaintInputSchema,
  output: supportSafetyAcknowledgementSchema,
  samples: [
    { verdict: 'accept', input: { requestKey: 'ethereum', topic: 'account', details: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const SUPPORT_SAFETY_REPORT_BEREAVEMENT = defineProcedure({
  ...base,
  name: 'support.safety.reportBereavement',
  kind: 'mutation',
  path: 'safety.reportBereavement',
  access: { caller: 'scope', scope: 'support:write' },
  refusals: {},
  input: supportBereavementInputSchema,
  output: supportSafetyAcknowledgementSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestKey: 'ethereum',
        deceasedName: 'USDC',
        dateOfDeath: '2026-01-01',
        relation: 'spouse_or_partner',
        reporterName: 'USDC',
        reporterContact: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** A scam report with its amount and the transfer it went out on (BK-safe-02, J-bank-18 #3), acknowledged once. */
export const SUPPORT_SAFETY_REPORT_SCAM = defineProcedure({
  ...base,
  name: 'support.safety.reportScam',
  kind: 'mutation',
  path: 'safety.reportScam',
  access: { caller: 'scope', scope: 'support:write' },
  refusals: {},
  input: supportScamReportInputSchema,
  checks: {
    support_scam_report_input_holds: {
      at: 'input',
      says: 'a report after sending money names the transfer; before sending money there is no transfer to name',
    },
    amount_holds: { at: 'input.amount', says: 'an amount is greater than zero' },
  },
  output: supportSafetyAcknowledgementSchema,
  samples: [
    { verdict: 'accept', input: { when: 'before_sending', amount: '1', assetId: 'USDC', contactedBy: 'phone_call' } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'support_scam_report_input_holds',
      input: { when: 'after_sending', amount: '1', assetId: 'USDC', contactedBy: 'phone_call' },
    },
    { verdict: 'refuse', by: 'amount_holds', input: { when: 'before_sending', amount: '0', assetId: 'USDC', contactedBy: 'phone_call' } },
  ],
});
