import { z } from 'zod';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';
import { quantLifecycleSchema, quantNotifySettingsSchema, quantPromoteOutputSchema, quantRiskScreenSchema } from './quant-algo.js';

/**
 * svc-quant's per-strategy settings, one record per call: a strategy's risk screen (`risk.*`, AL-risk-01), its
 * notification channels (`notify.*`, AL-live-06) and its stage and promotion gate (`lifecycle.*`, AL-lifecycle-01).
 * Each is the account's own and simulated: none moves value. svc-quant mounts each from here (`routes/risk.ts`,
 * `routes/notify.ts`, `routes/lifecycle.ts`) and the customer app calls each by its record.
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;

/** The status each refusal leaves with: svc-quant's `toTrpc` (`routes/core.ts`). */
const STATUS = {
  'quant.studio_not_found': 'NOT_FOUND',
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
  'quant.risk_cap_unset': 'PRECONDITION_FAILED',
  'quant.gate_criteria_unset': 'PRECONDITION_FAILED',
  'quant.stage_transition_invalid': 'PRECONDITION_FAILED',
  'quant.risk_cap_invalid': 'BAD_REQUEST',
  'quant.notify_channel_unavailable': 'BAD_REQUEST',
  'quant.params_invalid': 'BAD_REQUEST',
} as const satisfies Refusals;
type QuantRefusalCode = keyof typeof STATUS;
/** Every call reads the account's strategy first: missing, binned, or no database wired. */
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
/** An operator or teammate may name the account; otherwise it is the caller's own (`resolveStudioAccount`). */
const accountField = { accountId: z.string().guid().optional() };
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

export const QUANT_RISK_GET = defineProcedure({
  ...base,
  name: 'quant.risk.get',
  kind: 'query',
  path: 'risk.get',
  refusals: refuse(),
  input: z.object({ strategyId, ...accountField }),
  output: quantRiskScreenSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'accept', input: { strategyId: 's-1', accountId: ACCOUNT } },
    { verdict: 'refuse', input: { strategyId: '' } },
    { verdict: 'refuse', input: { strategyId: 's-1', accountId: 'not-a-uuid' } },
  ],
});

export const QUANT_RISK_SET = defineProcedure({
  ...base,
  name: 'quant.risk.set',
  kind: 'mutation',
  path: 'risk.set',
  refusals: refuse('quant.risk_cap_invalid'),
  input: z.object({
    strategyId,
    caps: z.object({
      depositPercent: z.string().max(40),
      maxPositionNotional: z.string().max(40),
      maxDailyLoss: z.string().max(40),
      equityFloor: z.string().max(40),
    }),
    floorPolicy: z.string().max(20),
    ...accountField,
  }),
  output: quantRiskScreenSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        strategyId: 's-1',
        caps: { depositPercent: '10', maxPositionNotional: '', maxDailyLoss: '', equityFloor: '' },
        floorPolicy: 'reduce_only',
      },
    },
    { verdict: 'refuse', input: { strategyId: 's-1', caps: { depositPercent: '10' }, floorPolicy: 'reduce_only' } },
    {
      verdict: 'refuse',
      input: {
        strategyId: 's-1',
        caps: { depositPercent: 10, maxPositionNotional: '', maxDailyLoss: '', equityFloor: '' },
        floorPolicy: '',
      },
    },
  ],
});

export const QUANT_RISK_TRADING = defineProcedure({
  ...base,
  name: 'quant.risk.trading',
  kind: 'mutation',
  path: 'risk.trading',
  refusals: refuse('quant.risk_cap_unset'),
  input: z.object({ strategyId, on: z.boolean(), ...accountField }),
  output: quantRiskScreenSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', on: true } },
    { verdict: 'accept', input: { strategyId: 's-1', on: false } },
    { verdict: 'refuse', input: { strategyId: 's-1', on: 'yes' } },
    { verdict: 'refuse', input: { strategyId: 's-1' } },
  ],
});

export const QUANT_NOTIFY_GET = defineProcedure({
  ...base,
  name: 'quant.notify.get',
  kind: 'query',
  path: 'notify.get',
  refusals: refuse(),
  input: z.object({ strategyId, ...accountField }),
  output: quantNotifySettingsSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { strategyId: 'x'.repeat(129) } },
  ],
});

export const QUANT_NOTIFY_SET = defineProcedure({
  ...base,
  name: 'quant.notify.set',
  kind: 'mutation',
  path: 'notify.set',
  // A listed channel with no sender (`webhook`, `chat`) refuses as unavailable; a word that is no channel at all as invalid.
  refusals: refuse('quant.notify_channel_unavailable', 'quant.params_invalid'),
  input: z.object({ strategyId, channels: z.array(z.string().max(20)).max(8), ...accountField }),
  output: quantNotifySettingsSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', channels: ['email'] } },
    { verdict: 'accept', input: { strategyId: 's-1', channels: [] } },
    { verdict: 'refuse', input: { strategyId: 's-1', channels: 'email' } },
    { verdict: 'refuse', input: { strategyId: 's-1', channels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] } },
  ],
});

const version = z.number().int().positive();

export const QUANT_LIFECYCLE_GET = defineProcedure({
  ...base,
  name: 'quant.lifecycle.get',
  kind: 'query',
  path: 'lifecycle.get',
  refusals: refuse(),
  input: z.object({ strategyId, strategyVersion: version, ...accountField }),
  output: quantLifecycleSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', strategyVersion: 1 } },
    { verdict: 'refuse', input: { strategyId: 's-1', strategyVersion: 0 } },
    { verdict: 'refuse', input: { strategyId: 's-1', strategyVersion: 1.5 } },
  ],
});

export const QUANT_LIFECYCLE_PROMOTE = defineProcedure({
  ...base,
  name: 'quant.lifecycle.promote',
  kind: 'mutation',
  path: 'lifecycle.promote',
  // A blank owner criterion refuses naming it and writes nothing; a version already past paper cannot be promoted again.
  refusals: refuse('quant.gate_criteria_unset', 'quant.stage_transition_invalid'),
  input: z.object({ strategyId, strategyVersion: version, seq: z.number().int().nonnegative(), ...accountField }),
  output: quantPromoteOutputSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1', strategyVersion: 1, seq: 0 } },
    { verdict: 'refuse', input: { strategyId: 's-1', strategyVersion: 1, seq: -1 } },
    { verdict: 'refuse', input: { strategyId: 's-1', strategyVersion: 1 } },
  ],
});

export const QUANT_STRATEGY_SETTINGS_PROCEDURES = [
  QUANT_RISK_GET,
  QUANT_RISK_SET,
  QUANT_RISK_TRADING,
  QUANT_NOTIFY_GET,
  QUANT_NOTIFY_SET,
  QUANT_LIFECYCLE_GET,
  QUANT_LIFECYCLE_PROMOTE,
] as const;
