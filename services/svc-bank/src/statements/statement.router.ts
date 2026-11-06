import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { throwBankProcedure } from '../bank-procedure.js';
import { BankError } from '../errors.js';
import { STATEMENT_REPORTS } from './statement-service.js';

/**
 * `bank.statements.export` — a signed CSV or a one-month PDF of the caller's
 * own posted lines, plus a proof object that names the holder, the period and
 * the file hash. It does not state a balance.
 */

export const lineTotalOutput = z.object({
  asset: z.string(),
  net: z.string().regex(/^-?\d+(\.\d{1,18})?$/),
  lines: z.number().int().nonnegative(),
});

const statementOutput = z.object({
  format: z.enum(['csv', 'pdf']),
  filename: z.string(),
  contentType: z.string(),
  bodyBase64: z.string(),
  sha256: z.string(),
  signature: z.string(),
  rowCount: z.number().int().nonnegative(),
  /** Per asset, the net of the file's lines; the same fold as `activity.totals`. Not a balance. */
  totals: z.array(lineTotalOutput).optional(),
  generatedAt: z.string().datetime(),
  proof: z.object({
    holderUserId: z.string().guid(),
    from: z.string(),
    to: z.string(),
    assetId: z.string().nullable(),
    spaceId: z.string().nullable(),
    report: z.enum(['statement', 'ledger', 'trades']),
    rowCount: z.number().int().nonnegative(),
    generatedAt: z.string().datetime(),
    sha256: z.string(),
  }),
});

const jobOutput = z.object({
  id: z.string().guid(),
  report: z.enum(['statement', 'ledger', 'trades']),
  format: z.enum(['csv', 'pdf']),
  from: z.string(),
  to: z.string(),
  assetId: z.string().nullable(),
  spaceId: z.string().nullable(),
  state: z.enum(['queued', 'rendering', 'ready', 'failed']),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  filename: z.string().nullable(),
  sha256: z.string().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
});

const requestInput = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    assetId: z.string().min(1).max(16).optional(),
    spaceId: z.string().guid().optional(),
    format: z.enum(['csv', 'pdf']),
    report: z.enum(STATEMENT_REPORTS).optional(),
  })
  .strict();

export function createStatementsRouter(bank: Pick<BankServices, 'statements' | 'statementJobs'>) {
  return router({
    export: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            from: z.string().datetime({ offset: true }),
            to: z.string().datetime({ offset: true }),
            assetId: z.string().min(1).max(16).optional(),
            /** One of the caller's own named spaces: only its lines (BK-pots-02). */
            spaceId: z.string().guid().optional(),
            format: z.enum(['csv', 'pdf']),
            /** What the file holds (PF-statements-01); the account statement when left out. */
            report: z.enum(STATEMENT_REPORTS).optional(),
          })
          .strict(),
      )
      .output(statementOutput)
      .query(async ({ ctx, input }) => {
        try {
          return await bank.statements.export(ctx.principal.userId, input);
        } catch (err) {
          throwBankProcedure(err);
        }
      }),
    /**
     * J-bank-16 #2 (BK-acct-07): an account ownership letter or a balance certificate. A letter is issued on a banking
     * partner's paper, and none is wired, so the request refuses `rail.bank` and nothing is stored or sent.
     */
    /** J-bank-16 #1: the net per asset of every posted line in a range, the same fold a statement prints. Self-only. */
    totals: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            from: z.string().datetime({ offset: true }),
            to: z.string().datetime({ offset: true }),
            assetId: z.string().min(1).max(16).optional(),
          })
          .strict(),
      )
      .output(z.object({ totals: z.array(lineTotalOutput), lines: z.number().int().nonnegative() }))
      .query(async ({ ctx, input }) => {
        try {
          return await bank.statements.totals(ctx.principal.userId, input);
        } catch (err) {
          throwBankProcedure(err);
        }
      }),
    letters: router({
      request: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ kind: z.enum(['ownership', 'balance']) }).strict())
        .output(z.object({ id: z.string() }))
        .mutation(async () => {
          throwBankProcedure(
            new BankError('A bank letter is issued with a banking partner, and none is connected in this build', 'rail.bank'),
          );
        }),
    }),
    /**
     * J-bank-16 #3 (BK-acct-07): tax statements. They are produced by a tax calculation provider, and none is wired, so
     * the list refuses `vendor.tax`; no tax figure is worked out here.
     */
    tax: router({
      list: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ year: z.number().int().min(1970).max(2200) }).strict())
        .output(z.object({ items: z.array(z.object({ id: z.string() })) }))
        .query(async () => {
          throwBankProcedure(
            new BankError('Tax statements are produced by a tax calculation provider, and none is connected in this build', 'vendor.tax'),
          );
        }),
    }),
    /**
     * PF-statements-02: background exports. `create` refuses now what the file would be refused for, else returns the one
     * job for that request (the same request, the same job); `list` is the document centre; `download` hands back a ready
     * job's signed file. Only ever the caller's own jobs.
     */
    jobs: router({
      create: scopedProcedure('bank:read', { module: 'bank' })
        .input(requestInput)
        .output(jobOutput)
        .mutation(async ({ ctx, input }) => {
          try {
            return await bank.statementJobs.create(ctx.principal.userId, input);
          } catch (err) {
            throwBankProcedure(err);
          }
        }),
      list: scopedProcedure('bank:read', { module: 'bank' })
        .output(z.object({ enabled: z.boolean(), items: z.array(jobOutput) }))
        .query(async ({ ctx }) => {
          try {
            return { enabled: bank.statementJobs.enabled, items: await bank.statementJobs.list(ctx.principal.userId) };
          } catch (err) {
            throwBankProcedure(err);
          }
        }),
      download: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ id: z.string().guid() }).strict())
        .output(statementOutput)
        .query(async ({ ctx, input }) => {
          try {
            return await bank.statementJobs.download(ctx.principal.userId, input.id);
          } catch (err) {
            throwBankProcedure(err);
          }
        }),
    }),
  });
}
