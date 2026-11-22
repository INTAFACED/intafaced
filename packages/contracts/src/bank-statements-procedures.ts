import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { jobOutput, lineTotalOutput, requestInput, STATEMENT_REPORTS, statementOutput } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `statements.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_STATEMENTS_EXPORT = defineProcedure({
  ...base,
  name: 'bank.statements.export',
  kind: 'query',
  path: 'statements.export',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      assetId: assetIdSchema.min(1).max(16).optional(),
      /** One of the caller's own named spaces: only its lines (BK-pots-02). */
      spaceId: z.string().guid().optional(),
      format: z.enum(['csv', 'pdf']),
      /** What the file holds (PF-statements-01); the account statement when left out. */
      report: z.enum(STATEMENT_REPORTS).optional(),
    })
    .strict(),
  output: statementOutput,
  samples: [
    { verdict: 'accept', input: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z', format: 'csv' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_STATEMENTS_JOBS_CREATE = defineProcedure({
  ...base,
  name: 'bank.statements.jobs.create',
  kind: 'mutation',
  path: 'statements.jobs.create',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: requestInput,
  output: jobOutput,
  samples: [
    { verdict: 'accept', input: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z', format: 'csv' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_STATEMENTS_JOBS_LIST = defineProcedure({
  ...base,
  name: 'bank.statements.jobs.list',
  kind: 'query',
  path: 'statements.jobs.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ enabled: z.boolean(), items: z.array(jobOutput) }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_STATEMENTS_JOBS_DOWNLOAD = defineProcedure({
  ...base,
  name: 'bank.statements.jobs.download',
  kind: 'query',
  path: 'statements.jobs.download',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ id: z.string().guid() }).strict(),
  output: statementOutput,
  samples: [
    { verdict: 'accept', input: { id: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * J-bank-16 #2 (BK-acct-07): an account ownership letter or a balance certificate. A letter is issued on a banking
 * partner's paper, and none is wired, so the request refuses `rail.bank` and nothing is stored or sent.
 */
export const BANK_STATEMENTS_LETTERS_REQUEST = defineProcedure({
  ...base,
  name: 'bank.statements.letters.request',
  kind: 'mutation',
  path: 'statements.letters.request',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ kind: z.enum(['ownership', 'balance']) }).strict(),
  output: z.object({ id: z.string() }),
  samples: [
    { verdict: 'accept', input: { kind: 'ownership' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_STATEMENTS_TAX_LIST = defineProcedure({
  ...base,
  name: 'bank.statements.tax.list',
  kind: 'query',
  path: 'statements.tax.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ year: z.number().int().min(1970).max(2200) }).strict(),
  output: z.object({ items: z.array(z.object({ id: z.string() })) }),
  samples: [
    { verdict: 'accept', input: { year: 1970 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** J-bank-16 #1: the net per asset of every posted line in a range, the same fold a statement prints. Self-only. */
export const BANK_STATEMENTS_TOTALS = defineProcedure({
  ...base,
  name: 'bank.statements.totals',
  kind: 'query',
  path: 'statements.totals',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      assetId: assetIdSchema.min(1).max(16).optional(),
    })
    .strict(),
  output: z.object({ totals: z.array(lineTotalOutput), lines: z.number().int().nonnegative() }),
  samples: [
    { verdict: 'accept', input: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' } },
    { verdict: 'refuse', input: 42 },
  ],
});
