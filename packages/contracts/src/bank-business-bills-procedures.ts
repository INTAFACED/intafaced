import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  businessBillLimitsSchema,
  businessBillSchema,
  businessBillSettingsSchema,
  businessBillVendorSchema,
} from './bank-business-bills.js';
import { accountInput, amountString, billInput, day, MAX_SPLIT_LINES, stepUpApprovalField } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `businessBills.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_BUSINESS_BILLS_LIST = defineProcedure({
  ...base,
  name: 'bank.businessBills.list',
  kind: 'query',
  path: 'businessBills.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: z.array(businessBillSchema),
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_SETTINGS = defineProcedure({
  ...base,
  name: 'bank.businessBills.settings',
  kind: 'query',
  path: 'businessBills.settings',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: businessBillSettingsSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_GET = defineProcedure({
  ...base,
  name: 'bank.businessBills.get',
  kind: 'query',
  path: 'businessBills.get',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: billInput,
  output: businessBillSchema,
  samples: [
    { verdict: 'accept', input: { billId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_SET_VENDOR = defineProcedure({
  ...base,
  name: 'bank.businessBills.setVendor',
  kind: 'mutation',
  path: 'businessBills.setVendor',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), name: z.string().min(1).max(128), cap: amountString }).strict(),
  output: businessBillVendorSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222', name: 'placeholder', cap: '1.50' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_SET_LIMITS = defineProcedure({
  ...base,
  name: 'bank.businessBills.setLimits',
  kind: 'mutation',
  path: 'businessBills.setLimits',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      perPayment: amountString.nullable(),
      daily: amountString.nullable(),
      monthly: amountString.nullable(),
    })
    .strict(),
  output: businessBillLimitsSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222', perPayment: '1.50', daily: '1.50', monthly: '1.50' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_CLEAR_DUPLICATE = defineProcedure({
  ...base,
  name: 'bank.businessBills.clearDuplicate',
  kind: 'mutation',
  path: 'businessBills.clearDuplicate',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: billInput,
  output: businessBillSchema,
  samples: [
    { verdict: 'accept', input: { billId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_REVIEW = defineProcedure({
  ...base,
  name: 'bank.businessBills.review',
  kind: 'mutation',
  path: 'businessBills.review',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      billId: z.string().guid(),
      vendor: z.string().max(128).nullable(),
      reference: z.string().max(64).nullable(),
      amount: amountString.nullable(),
      dueDate: day.nullable(),
    })
    .strict(),
  output: businessBillSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        billId: '22222222-2222-4222-8222-222222222222',
        vendor: 'placeholder',
        reference: 'placeholder',
        amount: '1.50',
        dueDate: '2026-01-01',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_SUBMIT = defineProcedure({
  ...base,
  name: 'bank.businessBills.submit',
  kind: 'mutation',
  path: 'businessBills.submit',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: billInput,
  output: businessBillSchema,
  samples: [
    { verdict: 'accept', input: { billId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_APPROVE = defineProcedure({
  ...base,
  name: 'bank.businessBills.approve',
  kind: 'mutation',
  path: 'businessBills.approve',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: billInput,
  output: businessBillSchema,
  samples: [
    { verdict: 'accept', input: { billId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Pays an approved bill now, or schedules it: one partner instruction under its own key, sent once. */
export const BANK_BUSINESS_BILLS_PAY = defineProcedure({
  ...base,
  name: 'bank.businessBills.pay',
  kind: 'mutation',
  path: 'businessBills.pay',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      billId: z.string().guid(),
      paymentId: z.string().guid(),
      scheduledFor: day.nullable(),
      splits: z.array(z.object({ category: z.string().min(1).max(64), amount: amountString }).strict()).max(MAX_SPLIT_LINES),
      stepUpApprovalId: stepUpApprovalField,
    })
    .strict(),
  output: businessBillSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        billId: '22222222-2222-4222-8222-222222222222',
        paymentId: '22222222-2222-4222-8222-222222222222',
        scheduledFor: '2026-01-01',
        splits: [],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BILLS_CANCEL = defineProcedure({
  ...base,
  name: 'bank.businessBills.cancel',
  kind: 'mutation',
  path: 'businessBills.cancel',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid() }).strict(),
  output: businessBillSchema,
  samples: [
    { verdict: 'accept', input: { paymentId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** A payment whose partner answer was not definite, sent again under the same key: made at most once. */
export const BANK_BUSINESS_BILLS_RESEND = defineProcedure({
  ...base,
  name: 'bank.businessBills.resend',
  kind: 'mutation',
  path: 'businessBills.resend',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ paymentId: z.string().guid() }).strict(),
  output: businessBillSchema,
  samples: [
    { verdict: 'accept', input: { paymentId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});
