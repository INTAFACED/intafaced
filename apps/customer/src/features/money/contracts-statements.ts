/** Account statements, statement files and letters. */
import { z } from 'zod';
import { signedDecimalSchema } from '../../shared/money';

/** A signed statement file from `bank.statements.export`: the whole account, or one space (BK-pots-02). */
/** Per coin, the net of a set of posted lines (J-bank-16 #1): money in minus money out. Not a balance. */
export const lineTotalSchema = z.object({ asset: z.string(), net: signedDecimalSchema, lines: z.number().int().nonnegative() });
export type LineTotal = z.infer<typeof lineTotalSchema>;
export const statementFileSchema = z.object({
  format: z.enum(['csv', 'pdf']),
  filename: z.string(),
  contentType: z.string(),
  bodyBase64: z.string(),
  sha256: z.string(),
  rowCount: z.number().int().nonnegative(),
  totals: z.array(lineTotalSchema).optional(),
});
/** `bank.statements.totals`: the same fold over the same lines as a statement, for any range. */
export const lineTotalsSchema = z.object({ totals: z.array(lineTotalSchema), lines: z.number().int().nonnegative() });
/** `bank.statements.tax.list`: tax statements for a year (refused `vendor.tax` while no provider is connected). */
export const taxStatementsSchema = z.object({ items: z.array(z.object({ id: z.string() })) });
/** `bank.letters.request` (refused `rail.bank` while no banking partner is connected). */
export const letterRequestSchema = z.object({ id: z.string() });
/** One background export from `bank.statements.jobs` (PF-statements-02): what was asked, and where it is. */
export const statementJobSchema = z.object({
  id: z.string(),
  report: z.enum(['statement', 'ledger', 'trades']),
  format: z.enum(['csv', 'pdf']),
  from: z.string(),
  to: z.string(),
  state: z.enum(['queued', 'rendering', 'ready', 'failed']),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
  filename: z.string().nullable(),
  sha256: z.string().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
});
export type StatementJob = z.infer<typeof statementJobSchema>;
/** The document centre: whether background exports are on here, and the person's own jobs, newest first. */
export const statementJobsSchema = z.object({ enabled: z.boolean(), items: z.array(statementJobSchema) });
/** `bank.loans.statement` (BK-loan-06): one loan's signed CSV over a period; a month still running is provisional. */
