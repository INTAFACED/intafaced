import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  BUSINESS_BOOK_FORMATS,
  businessAccountingConnectionSchema,
  businessBookLineSchema,
  businessBookStatementSchema,
  businessCodingRuleSchema,
  businessBooksOverviewSchema,
} from './bank-business-books.js';
import { accountId, period } from './bank-call-schemas.js';
import { stepUpApprovalField } from './bank-cards-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `businessBooks.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Asks to connect accounting software: `vendor.accounting` is switched off, so the record is kept and nothing connects. */
export const BANK_BUSINESS_BOOKS_CONNECT_ACCOUNTING = defineProcedure({
  ...base,
  name: 'bank.businessBooks.connectAccounting',
  kind: 'mutation',
  path: 'businessBooks.connectAccounting',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId }).strict(),
  output: businessAccountingConnectionSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * One period's statement in one format, checked against the partner's own. A period reaching back past the partner's
 * strong customer authentication age needs a fresh confirmation bound to `exportId` and the exact period.
 */
export const BANK_BUSINESS_BOOKS_EXPORT_STATEMENT = defineProcedure({
  ...base,
  name: 'bank.businessBooks.exportStatement',
  kind: 'mutation',
  path: 'businessBooks.exportStatement',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId,
      ...period,
      format: z.enum(BUSINESS_BOOK_FORMATS),
      exportId: z.string().guid(),
      stepUpApprovalId: stepUpApprovalField,
    })
    .strict(),
  output: businessBookStatementSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '11111111-1111-4111-8111-111111111111',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
        format: 'csv',
        exportId: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BOOKS_SAVE_RULE = defineProcedure({
  ...base,
  name: 'bank.businessBooks.saveRule',
  kind: 'mutation',
  path: 'businessBooks.saveRule',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId,
      ruleId: z.string().guid(),
      payeeContains: z.string().min(1).max(80),
      category: z.string().min(1).max(60),
      glCode: z.string().max(32).nullable().optional(),
    })
    .strict(),
  output: businessCodingRuleSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '11111111-1111-4111-8111-111111111111',
        ruleId: '11111111-1111-4111-8111-111111111111',
        payeeContains: 'USDC',
        category: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The lines a rule would code, before it is saved. Changes nothing. */
export const BANK_BUSINESS_BOOKS_TEST_RULE = defineProcedure({
  ...base,
  name: 'bank.businessBooks.testRule',
  kind: 'query',
  path: 'businessBooks.testRule',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ accountId, ...period, payeeContains: z.string().min(1).max(80) }).strict(),
  output: z.object({ matches: z.array(businessBookLineSchema) }),
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '11111111-1111-4111-8111-111111111111',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
        payeeContains: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One line or many at once: a category, a GL code or both. */
export const BANK_BUSINESS_BOOKS_CODE_LINES = defineProcedure({
  ...base,
  name: 'bank.businessBooks.codeLines',
  kind: 'mutation',
  path: 'businessBooks.codeLines',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId,
      ...period,
      lineIds: z.array(z.string().min(1).max(128)).min(1).max(200),
      category: z.string().max(60).nullable().optional(),
      glCode: z.string().max(32).nullable().optional(),
    })
    .strict(),
  output: z.object({ items: z.array(businessBookLineSchema) }),
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '11111111-1111-4111-8111-111111111111',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
        lineIds: ['USDC'],
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BOOKS_OVERVIEW = defineProcedure({
  ...base,
  name: 'bank.businessBooks.overview',
  kind: 'query',
  path: 'businessBooks.overview',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ accountId }).strict(),
  output: businessBooksOverviewSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_BOOKS_LINES = defineProcedure({
  ...base,
  name: 'bank.businessBooks.lines',
  kind: 'query',
  path: 'businessBooks.lines',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ accountId, ...period }).strict(),
  output: z.object({ items: z.array(businessBookLineSchema) }),
  samples: [
    {
      verdict: 'accept',
      input: { accountId: '22222222-2222-4222-8222-222222222222', from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
