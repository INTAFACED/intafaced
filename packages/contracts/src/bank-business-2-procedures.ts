import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString, businessAccountOutput, businessApprovalOutput } from './bank-call-schemas.js';
import { stepUpApprovalField } from './bank-cards-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `business.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_BUSINESS_PROPOSE_TRANSFER = defineProcedure({
  ...base,
  name: 'bank.business.proposeTransfer',
  kind: 'mutation',
  path: 'business.proposeTransfer',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    accountId: z.string().guid(),
    fromSpaceId: z.string().guid(),
    toSpaceId: z.string().guid(),
    amount: amountString,
    clientId: z.string().guid(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('posted'),
      transferId: z.string(),
      ledgerTxId: z.string(),
    }),
    z.object({
      kind: z.literal('pending'),
      approval: businessApprovalOutput,
    }),
  ]),
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '11111111-1111-4111-8111-111111111111',
        fromSpaceId: '11111111-1111-4111-8111-111111111111',
        toSpaceId: '11111111-1111-4111-8111-111111111111',
        amount: '1',
        clientId: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_CREATE = defineProcedure({
  ...base,
  name: 'bank.business.create',
  kind: 'mutation',
  path: 'business.create',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    accountId: z.string().guid(),
    name: z.string().min(1).max(128),
    assetId: z.string().min(1).max(16),
    spendThreshold: amountString,
  }),
  output: businessAccountOutput,
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111', name: 'USDC', assetId: 'USDC', spendThreshold: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_RUN_PAYROLL = defineProcedure({
  ...base,
  name: 'bank.business.runPayroll',
  kind: 'mutation',
  path: 'business.runPayroll',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    payrollId: z.string().guid(),
    accountId: z.string().guid(),
    fromSpaceId: z.string().guid(),
    recipients: z
      .array(z.object({ toSpaceId: z.string().guid(), amount: amountString }))
      .min(1)
      .max(64),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: z.object({
    payrollId: z.string(),
    accountId: z.string(),
    fromSpaceId: z.string(),
    assetId: z.string(),
    ledgerTxId: z.string(),
    recipients: z.array(z.object({ toSpaceId: z.string(), amount: amountString })),
    createdAt: z.string(),
  }),
  samples: [
    {
      verdict: 'accept',
      input: {
        payrollId: '11111111-1111-4111-8111-111111111111',
        accountId: '11111111-1111-4111-8111-111111111111',
        fromSpaceId: '11111111-1111-4111-8111-111111111111',
        recipients: [{ toSpaceId: '11111111-1111-4111-8111-111111111111', amount: '1' }],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
