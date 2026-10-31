import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { throwBankProcedure } from '../bank-procedure.js';
import { STATEMENT_REPORTS } from './statement-service.js';

/**
 * `bank.statements.export` — a signed CSV or a one-month PDF of the caller's
 * own posted lines, plus a proof object that names the holder, the period and
 * the file hash. It does not state a balance.
 */

const statementOutput = z.object({
  format: z.enum(['csv', 'pdf']),
  filename: z.string(),
  contentType: z.string(),
  bodyBase64: z.string(),
  sha256: z.string(),
  signature: z.string(),
  rowCount: z.number().int().nonnegative(),
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

export function createStatementsRouter(bank: Pick<BankServices, 'statements'>) {
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
  });
}
