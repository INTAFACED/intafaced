/** Account statements, statement files and letters. */
import { z } from 'zod';
import { signedDecimalSchema } from '../../shared/money';

/** Per coin, the net of a set of posted lines (J-bank-16 #1): money in minus money out. Not a balance. */
const lineTotalSchema = z.object({ asset: z.string(), net: signedDecimalSchema, lines: z.number().int().nonnegative() });
export type LineTotal = z.infer<typeof lineTotalSchema>;
/** One background export from `bank.statements.jobs` (PF-statements-02): what was asked, and where it is. */
const statementJobSchema = z.object({
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
/** `bank.loans.statement` (BK-loan-06): one loan's signed CSV over a period; a month still running is provisional. */
