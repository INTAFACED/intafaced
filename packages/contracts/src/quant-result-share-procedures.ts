import { z } from 'zod';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';
import { quantPublicResultSchema, quantReportSchema, quantShareCreatedSchema, quantShareStateSchema } from './quant-algo.js';

/**
 * svc-quant's report and share links of one stored backtest (AL-report-03), one record per call the app makes: the print
 * document (`backtest.report`), the run's link state (`result.share.get`), a new link (`result.share.create`), revoking
 * it (`result.share.revoke`) and the signed-out read a link opens (`result.share.public`). Each reads a simulated run:
 * none moves value. svc-quant mounts each from here (`routes/backtest.ts`, `routes/result.ts`) and the customer app calls
 * each by its record.
 */

/**
 * Served wherever quant's fiat plane is, with or without a principal. The owner's calls resolve the account themselves;
 * `result.share.public` is the signed-out read of a link and reads no account at all.
 */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;

/** The status each refusal leaves with: svc-quant's `toTrpc` (`routes/core.ts`). */
const STATUS = {
  'quant.run_not_found': 'NOT_FOUND',
  'quant.share_not_found': 'NOT_FOUND',
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
  'quant.share_rate_unset': 'PRECONDITION_FAILED',
  'quant.share_window_unset': 'PRECONDITION_FAILED',
  'quant.share_rate_limited': 'PRECONDITION_FAILED',
  // `toTrpc` names no status for these two, so they leave as its fallback, BAD_REQUEST.
  'quant.share_seq_unset': 'BAD_REQUEST',
  'quant.share_seq_stale': 'BAD_REQUEST',
  // A share row the Postgres store cannot read back (an unreadable timestamp, or a link that was not stored).
  'quant.params_invalid': 'BAD_REQUEST',
} as const satisfies Refusals;
type QuantRefusalCode = keyof typeof STATUS;
const refusals = (...codes: QuantRefusalCode[]): Refusals =>
  Object.freeze(Object.fromEntries(codes.map((code): [string, RefusalStatus] => [code, STATUS[code]])));
/** Every share call needs the owner's read limit and window and the share store first. */
const SHARE_FIRST = [
  'quant.share_rate_unset',
  'quant.share_window_unset',
  'quant.database_url_unset',
  'quant.database_pool_max_unset',
  'quant.params_invalid',
] as const satisfies readonly QuantRefusalCode[];

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

const runId = z.string().min(1);
/** An operator or teammate may name the account; otherwise it is the caller's own (`resolveStudioAccount`). */
const accountField = { accountId: z.string().guid().optional() };
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
/**
 * The link count as sent. The handler judges it and refuses anything but a whole number from 0 by name
 * (`quant.share_seq_unset`), so the wire takes any JSON value here; the shape is named only so the record exports.
 */
const plain = [z.string(), z.number(), z.boolean(), z.null()] as const;
const sentSeq = z.union([z.object({}), z.array(z.union([z.object({}), ...plain])), ...plain]);

/** The print document of one of the caller's own bar backtests. Derived on read. */
export const QUANT_BACKTEST_REPORT = defineProcedure({
  ...base,
  name: 'quant.backtest.report',
  kind: 'query',
  path: 'backtest.report',
  refusals: refusals('quant.run_not_found', 'quant.database_url_unset', 'quant.database_pool_max_unset'),
  input: z.object({ runId, ...accountField }),
  output: quantReportSchema,
  samples: [
    { verdict: 'accept', input: { runId: 'r-1' } },
    { verdict: 'accept', input: { runId: 'r-1', accountId: ACCOUNT } },
    { verdict: 'refuse', input: { runId: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** How many links this run has, and whether one is active. The screen sends that count as `seq` on create. */
export const QUANT_RESULT_SHARE_GET = defineProcedure({
  ...base,
  name: 'quant.result.share.get',
  kind: 'query',
  path: 'result.share.get',
  refusals: refusals(...SHARE_FIRST, 'quant.run_not_found'),
  input: z.object({ runId, ...accountField }),
  output: quantShareStateSchema,
  samples: [
    { verdict: 'accept', input: { runId: 'r-1' } },
    { verdict: 'refuse', input: { runId: '' } },
    { verdict: 'refuse', input: { runId: 'r-1', accountId: 'not-a-uuid' } },
  ],
});

/**
 * One active link per run, under `result.share:<runId>:<seq>`; the token is returned only by the call that stores it. A
 * missing `seq` refuses unset and a `seq` that is not the stored count refuses stale, so a lost reply stores no second link.
 */
export const QUANT_RESULT_SHARE_CREATE = defineProcedure({
  ...base,
  name: 'quant.result.share.create',
  kind: 'mutation',
  path: 'result.share.create',
  refusals: refusals(...SHARE_FIRST, 'quant.run_not_found', 'quant.share_seq_unset', 'quant.share_seq_stale'),
  input: z.object({ runId, seq: sentSeq.optional(), ...accountField }),
  output: quantShareCreatedSchema,
  samples: [
    { verdict: 'accept', input: { runId: 'r-1', seq: 0 } },
    { verdict: 'accept', input: { runId: 'r-1' } },
    { verdict: 'accept', input: { runId: 'r-1', seq: 'five' } },
    { verdict: 'refuse', input: { runId: '', seq: 0 } },
    { verdict: 'refuse', input: { seq: 0 } },
  ],
});

/** Stops the run's active link opening. */
export const QUANT_RESULT_SHARE_REVOKE = defineProcedure({
  ...base,
  name: 'quant.result.share.revoke',
  kind: 'mutation',
  path: 'result.share.revoke',
  refusals: refusals(...SHARE_FIRST, 'quant.run_not_found'),
  input: z.object({ runId, ...accountField }),
  output: quantShareStateSchema,
  samples: [
    { verdict: 'accept', input: { runId: 'r-1' } },
    { verdict: 'refuse', input: { runId: 1 } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The signed-out read of a link. A revoked token and an unknown token answer the same not-found. */
export const QUANT_RESULT_SHARE_PUBLIC = defineProcedure({
  ...base,
  name: 'quant.result.share.public',
  kind: 'query',
  path: 'result.share.public',
  refusals: refusals(...SHARE_FIRST, 'quant.share_rate_limited', 'quant.share_not_found'),
  input: z.object({ token: z.string() }),
  output: quantPublicResultSchema,
  samples: [
    { verdict: 'accept', input: { token: 'placeholder-share-token' } },
    { verdict: 'accept', input: { token: '' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { token: 7 } },
  ],
});

export const QUANT_RESULT_SHARE_PROCEDURES = [
  QUANT_BACKTEST_REPORT,
  QUANT_RESULT_SHARE_GET,
  QUANT_RESULT_SHARE_CREATE,
  QUANT_RESULT_SHARE_REVOKE,
  QUANT_RESULT_SHARE_PUBLIC,
] as const;
