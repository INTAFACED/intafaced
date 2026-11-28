import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  businessBulkRunSchema,
  businessContractorBatchSchema,
  businessContractorInviteInfoSchema,
  businessContractorInviteSchema,
  businessContractorJoinedSchema,
  businessContractorSchema,
  businessCryptoPayrollSchema,
  businessPayrollWalletOfferSchema,
  businessPayrollWalletSchema,
} from './bank-business-payouts.js';
import {
  accountInput,
  address,
  amountString,
  contractorFields,
  day,
  MAX_BATCH_INVOICES,
  MAX_BULK_FILE_BYTES,
  MAX_PAYROLL_MEMBERS,
  stepUpApprovalField,
  signature,
} from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `businessPayouts.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_BUSINESS_PAYOUTS_RUNS = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.runs',
  kind: 'query',
  path: 'businessPayouts.runs',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessBulkRunSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_CONTRACTORS = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.contractors',
  kind: 'query',
  path: 'businessPayouts.contractors',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessContractorSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_BATCHES = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.batches',
  kind: 'query',
  path: 'businessPayouts.batches',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessContractorBatchSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_WALLET = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.wallet',
  kind: 'query',
  path: 'businessPayouts.wallet',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: businessPayrollWalletSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_PAYROLLS = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.payrolls',
  kind: 'query',
  path: 'businessPayouts.payrolls',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessCryptoPayrollSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_INVITE_INFO = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.inviteInfo',
  kind: 'query',
  path: 'businessPayouts.inviteInfo',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ token: z.string().min(16).max(128) }).strict(),
  output: businessContractorInviteInfoSchema,
  samples: [
    { verdict: 'accept', input: { token: 'placeholderxxxxx' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Imports a CSV as a draft run with its validation report. Nothing is held or sent. */
export const BANK_BUSINESS_PAYOUTS_IMPORT_RUN = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.importRun',
  kind: 'mutation',
  path: 'businessPayouts.importRun',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), runId: z.string().guid(), csv: z.string().min(1).max(MAX_BULK_FILE_BYTES) }).strict(),
  output: businessBulkRunSchema,
  samples: [
    {
      verdict: 'accept',
      input: { accountId: '22222222-2222-4222-8222-222222222222', runId: '22222222-2222-4222-8222-222222222222', csv: 'placeholder' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The funding step and the confirmation: at or above the business's threshold it waits for an approver. */
export const BANK_BUSINESS_PAYOUTS_CONFIRM_RUN = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.confirmRun',
  kind: 'mutation',
  path: 'businessPayouts.confirmRun',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ runId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }).strict(),
  output: businessBulkRunSchema,
  samples: [
    { verdict: 'accept', input: { runId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_APPROVE_RUN = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.approveRun',
  kind: 'mutation',
  path: 'businessPayouts.approveRun',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ runId: z.string().guid() }).strict(),
  output: businessBulkRunSchema,
  samples: [
    { verdict: 'accept', input: { runId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_ADD_INVOICE = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.addInvoice',
  kind: 'mutation',
  path: 'businessPayouts.addInvoice',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      contractorId: z.string().guid(),
      invoiceId: z.string().guid(),
      number: z.string().min(1).max(64),
      amount: amountString,
      dueDate: day.nullable(),
    })
    .strict(),
  output: businessContractorSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        contractorId: '22222222-2222-4222-8222-222222222222',
        invoiceId: '22222222-2222-4222-8222-222222222222',
        number: 'placeholder',
        amount: '1.50',
        dueDate: '2026-01-01',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_ADD_CONTRACTOR = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.addContractor',
  kind: 'mutation',
  path: 'businessPayouts.addContractor',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), contractorId: z.string().guid(), ...contractorFields }).strict(),
  output: businessContractorSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        contractorId: '22222222-2222-4222-8222-222222222222',
        name: 'placeholder',
        email: 'placeholder',
        iban: 'placeholder',
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Pays a batch of open invoices: the intent row first, then the business's approval rules, then the payout rail. */
export const BANK_BUSINESS_PAYOUTS_PAY_BATCH = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.payBatch',
  kind: 'mutation',
  path: 'businessPayouts.payBatch',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      batchId: z.string().guid(),
      invoiceIds: z.array(z.string().guid()).min(1).max(MAX_BATCH_INVOICES),
      stepUpApprovalId: stepUpApprovalField,
    })
    .strict(),
  output: businessContractorBatchSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        batchId: '22222222-2222-4222-8222-222222222222',
        invoiceIds: ['22222222-2222-4222-8222-222222222222'],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_APPROVE_BATCH = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.approveBatch',
  kind: 'mutation',
  path: 'businessPayouts.approveBatch',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ batchId: z.string().guid() }).strict(),
  output: businessContractorBatchSchema,
  samples: [
    { verdict: 'accept', input: { batchId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_CREATE_INVITE = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.createInvite',
  kind: 'mutation',
  path: 'businessPayouts.createInvite',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: businessContractorInviteSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_WALLET_OFFER = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.walletOffer',
  kind: 'mutation',
  path: 'businessPayouts.walletOffer',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), address }).strict(),
  output: businessPayrollWalletOfferSchema,
  samples: [
    {
      verdict: 'accept',
      input: { accountId: '22222222-2222-4222-8222-222222222222', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_CREATE_PAYROLL = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.createPayroll',
  kind: 'mutation',
  path: 'businessPayouts.createPayroll',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      payrollId: z.string().guid(),
      name: z.string().min(1).max(128),
      dayOfMonth: z.number().int().min(1).max(28),
      members: z
        .array(z.object({ contractorId: z.string().guid(), amount: amountString }).strict())
        .min(1)
        .max(MAX_PAYROLL_MEMBERS),
    })
    .strict(),
  output: businessCryptoPayrollSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        payrollId: '22222222-2222-4222-8222-222222222222',
        name: 'placeholder',
        dayOfMonth: 1,
        members: [{ contractorId: '22222222-2222-4222-8222-222222222222', amount: '1.50' }],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The contractor adds themselves through a one-use link, with their own payout IBAN and wallet. */
export const BANK_BUSINESS_PAYOUTS_JOIN_AS_CONTRACTOR = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.joinAsContractor',
  kind: 'mutation',
  path: 'businessPayouts.joinAsContractor',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ token: z.string().min(16).max(128), ...contractorFields }).strict(),
  output: businessContractorJoinedSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        token: 'placeholderxxxxx',
        name: 'placeholder',
        email: 'placeholder',
        iban: 'placeholder',
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_PAYOUTS_CONNECT_WALLET = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.connectWallet',
  kind: 'mutation',
  path: 'businessPayouts.connectWallet',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ offerId: z.string().guid(), signature }).strict(),
  output: businessPayrollWalletSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        offerId: '22222222-2222-4222-8222-222222222222',
        signature:
          '0xababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One month's run and its payslips, under its run key: nothing is sent, held or posted. */
export const BANK_BUSINESS_PAYOUTS_PREPARE_RUN = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.prepareRun',
  kind: 'mutation',
  path: 'businessPayouts.prepareRun',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ payrollId: z.string().guid(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict(),
  output: businessCryptoPayrollSchema,
  samples: [
    { verdict: 'accept', input: { payrollId: '22222222-2222-4222-8222-222222222222', period: '2026-11' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The business's own wallet's signature over the run's message. */
export const BANK_BUSINESS_PAYOUTS_SIGN_RUN = defineProcedure({
  ...base,
  name: 'bank.businessPayouts.signRun',
  kind: 'mutation',
  path: 'businessPayouts.signRun',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ runId: z.string().guid(), signature }).strict(),
  output: businessCryptoPayrollSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        runId: '22222222-2222-4222-8222-222222222222',
        signature:
          '0xababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
