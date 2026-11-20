import { z } from 'zod';
import { quantSignalRulesSchema } from './quant-algo.js';

/**
 * svc-quant's wire shapes that its records share: moved unchanged from svc-quant's `routes/core.ts`, which re-exports
 * them under their old names, so the service's routers and its records parse the same schema.
 */

/** Every simulated answer says so: where it ran, that it is not live, and the label it is shown with. */
export const quantSimulatedStampSchema = z.object({
  environment: z.enum(['paper', 'backtest', 'shadow']),
  kind: z.enum(['paper', 'simulated']),
  claimLabel: z.enum(['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance']),
  live: z.literal(false),
  simulated: z.literal(true),
});

export const quantEnvironmentInputSchema = z.object({
  environment: z.string().optional().nullable(),
  presentedAs: z.string().optional().nullable(),
});

export const quantDecimalSchema = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'amounts are decimal strings with at most 18 decimal places');

export const QUANT_SANDBOX_LANGUAGES = ['javascript', 'typescript', 'python'] as const;
export const quantLanguageSchema = z.enum(QUANT_SANDBOX_LANGUAGES);

/** An operator or teammate may name the account; otherwise it is the caller's own (`resolveStudioAccount`). */
export const quantAccountField = { accountId: z.string().guid().optional() };
export const quantWriteKeyField = { idempotencyKey: z.string().optional().nullable() };

const quantFillSchema = z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string(),
  qty: z.string(),
  price: z.string(),
  venue: z.literal('internal'),
});

const quantRejectReasonSchema = z.enum([
  'quantity invalid',
  'price invalid',
  'time in force invalid',
  'unknown symbol',
  'limit hit',
  'insufficient cash',
  'exceeds position',
  'no short rule',
  'unknown order',
  'not open',
]);

/** One event of one paper order (AL-orders-01). */
const quantOrderEventSchema = z.object({
  seq: z.number().int(),
  order: z.string(),
  kind: z.enum(['new', 'accepted', 'filled', 'rejected', 'cancel_pending', 'cancelled']),
  type: z.enum(['market', 'limit']),
  side: z.enum(['buy', 'sell']),
  symbol: z.string(),
  qty: z.string(),
  tif: z.enum(['gtc', 'ioc']),
  market: z.string(),
  limit: z.string().optional(),
  price: z.string().optional(),
  reason: quantRejectReasonSchema.optional(),
  notional: z.string().optional(),
  fee: z.string().optional(),
  cash: z.string().optional(),
  position: z.string().optional(),
  reserved: z.string().optional(),
});

/** One leg of a reversal, each checked on its own (AL-orders-02). */
const quantReverseLegSchema = z.object({
  leg: z.enum(['close', 'open']),
  side: z.enum(['buy', 'sell']),
  symbol: z.string(),
  qty: z.string(),
  checked: z.literal(true),
  outcome: z.enum(['filled', 'refused']),
  order: z.string(),
  reason: quantRejectReasonSchema.nullable(),
});

/** `sandbox.run` and `studio.run`: one paper run of a script on the internal book. */
export const quantSandboxRunOutputSchema = z
  .object({
    ok: z.literal(true),
    language: quantLanguageSchema,
    logs: z.array(z.string()),
    cash: z.string(),
    pnl: z.string(),
    fills: z.array(quantFillSchema),
    positions: z.array(z.object({ symbol: z.string(), qty: z.string() })),
    events: z.array(quantOrderEventSchema),
    legs: z.array(quantReverseLegSchema),
    ticks: z.object({ label: z.literal('TEST'), path: z.record(z.string(), z.array(z.string())) }),
    venue: z.literal('internal'),
    venueVault: z.enum(['unset', 'set']),
    // A run stored before the limits were reported is read back without them.
    limits: z
      .object({
        wallClockMs: z.number().int().nullable(),
        memoryBytes: z.number().int().nullable(),
        outputBytes: z.number().int().nullable(),
        maxOps: z.number().int().nullable(),
        maxSource: z.number().int().nullable(),
      })
      .nullable()
      .default(null),
  })
  .merge(quantSimulatedStampSchema);

export const quantStudioBlockSchema = z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string().min(1).max(32),
  qty: quantDecimalSchema,
});

const quantStrategyVersionRecordSchema = z
  .object({
    version: z.number().int().positive(),
    createdAt: z.string(),
    name: z.string(),
    language: z.literal('javascript'),
    source: z.string(),
    cash: z.string(),
    blocks: z.array(quantStudioBlockSchema),
    modules: quantSignalRulesSchema.nullable(),
    risk: z.object({
      maxDrawdown: z.string(),
      maxNotional: z.string(),
      kill: z.string(),
    }),
    // A default, because a version stored before release notes existed was replayed without one.
    releaseNote: z.string().default(''),
  })
  .merge(quantSimulatedStampSchema);

export const quantStrategyHeadRecordSchema = quantStrategyVersionRecordSchema.extend({
  id: z.string(),
  accountId: z.string().guid(),
  clientStrategyId: z.string(),
  deletedAt: z.string().nullable(),
  // Defaults, because a write receipt stored before the head fields existed is replayed as it was stored.
  folder: z.string().default(''),
  description: z.string().default(''),
  organised: z.number().int().nonnegative().default(0),
  restores: z.number().int().nonnegative().default(0),
});

export const quantStrategyDetailRecordSchema = quantStrategyHeadRecordSchema.extend({
  versions: z.array(quantStrategyVersionRecordSchema),
});

/**
 * One strategy as `studio.get` answers it, with what the account's live approval policy allows (J-algo-dev-16 #4): the
 * live runner (svc-trade) starts a version only when the policy is off or that version holds a current approval.
 */
export const quantStrategyDetailForLiveSchema = quantStrategyDetailRecordSchema.extend({
  liveApproval: z.object({ required: z.boolean(), approvedVersions: z.array(z.number().int().positive()) }),
});

export const quantCostEvidenceSchema = z.object({
  kind: z.string(),
  source: z.string(),
});

/** `backtest.run`: a walk-forward run over the lake's recorded fills. */
export const quantWalkForwardRunOutputSchema = z
  .object({
    ok: z.literal(true),
    runId: z.string(),
    strategyId: z.string(),
    walkForward: z.object({
      inSampleFrom: z.string(),
      inSampleTo: z.string(),
      outOfSampleFrom: z.string(),
      outOfSampleTo: z.string(),
    }),
    inSample: z.object({ fillCount: z.number().int(), notional: quantDecimalSchema }),
    outOfSample: z.object({ fillCount: z.number().int(), notional: quantDecimalSchema }),
    claimLabel: z.literal('Historical simulation — not a forecast'),
    outOfSampleLabel: z.string(),
    strategyVersion: z.number().int().positive(),
  })
  .merge(quantSimulatedStampSchema);
