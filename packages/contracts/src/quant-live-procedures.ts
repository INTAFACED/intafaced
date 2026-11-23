import { z } from 'zod';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';
import { quantLiveCheckSchema } from './quant-algo.js';

/**
 * svc-quant's live deploy wizard, one record per call (AL-live-02; J-algo-dev-06): the compile check of one version
 * (`live.check`) and its Deploy (`live.deploy`). Neither moves value: the check writes nothing, and the deploy refuses on
 * every path (the live switch off, a version the runner can't trade, and, with both clear, the funding move and live run
 * this build does not have), storing nothing. svc-quant mounts each from here (`routes/live.ts`) and the customer app
 * calls each by its record.
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;

/** The status each refusal leaves with: svc-quant's `toTrpc` (`routes/core.ts`). */
const STATUS = {
  'quant.studio_not_found': 'NOT_FOUND',
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
  'quant.live_disabled': 'PRECONDITION_FAILED',
  'quant.approval_required': 'PRECONDITION_FAILED',
  'quant.live_deploy_unavailable': 'PRECONDITION_FAILED',
  'quant.live_plan_unsupported': 'BAD_REQUEST',
  'trade.order_type_unsupported': 'BAD_REQUEST',
} as const satisfies Refusals;
type QuantRefusalCode = keyof typeof STATUS;
/** Both calls read the account's strategy version first: missing, binned, or no database wired. */
const refuse = (...more: QuantRefusalCode[]): Refusals =>
  Object.freeze(
    Object.fromEntries(
      (['quant.studio_not_found', 'quant.database_url_unset', 'quant.database_pool_max_unset', ...more] as const).map(
        (code): [string, RefusalStatus] => [code, STATUS[code]],
      ),
    ),
  );

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

const strategyId = z.string().min(1).max(128);
const strategyVersion = z.number().int().positive();
/** An operator or teammate may name the account; otherwise it is the caller's own (`resolveStudioAccount`). */
const accountField = { accountId: z.string().guid().optional() };
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

/** The deploy wizard's compile check of one version: what it would place live and whether it can. Writes nothing. */
export const QUANT_LIVE_CHECK = defineProcedure({
  ...base,
  name: 'quant.live.check',
  kind: 'query',
  path: 'live.check',
  refusals: refuse(),
  input: z.object({ strategyId, strategyVersion, ...accountField }),
  output: quantLiveCheckSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', strategyVersion: 1 } },
    { verdict: 'accept', input: { strategyId: 's-1', strategyVersion: 2, accountId: ACCOUNT } },
    { verdict: 'refuse', input: { strategyId: 's-1', strategyVersion: 0 } },
    { verdict: 'refuse', input: { strategyId: '', strategyVersion: 1 } },
  ],
});

/**
 * The wizard's Deploy. A version the account's second-approver rule holds back refuses `quant.approval_required`; with
 * the platform's live switch off it refuses `quant.live_disabled`. Both refuse before anything is written: no deploy
 * intent exists. A version the runner can't trade refuses with the compile check's code; with both clear it
 * refuses `quant.live_deploy_unavailable`. It never answers: the amount is the TEST move the person's wallet would sign.
 */
export const QUANT_LIVE_DEPLOY = defineProcedure({
  ...base,
  name: 'quant.live.deploy',
  kind: 'mutation',
  path: 'live.deploy',
  refusals: refuse(
    'quant.approval_required',
    'quant.live_disabled',
    'quant.live_plan_unsupported',
    'trade.order_type_unsupported',
    'quant.live_deploy_unavailable',
  ),
  input: z.object({ strategyId, strategyVersion, amount: z.string().max(40), ...accountField }),
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', strategyVersion: 1, amount: '100' } },
    { verdict: 'accept', input: { strategyId: 's-1', strategyVersion: 1, amount: '' } },
    { verdict: 'refuse', input: { strategyId: 's-1', strategyVersion: 1 } },
    { verdict: 'refuse', input: { strategyId: 's-1', strategyVersion: 1, amount: 100 } },
  ],
});

export const QUANT_LIVE_PROCEDURES = [QUANT_LIVE_CHECK, QUANT_LIVE_DEPLOY] as const;
