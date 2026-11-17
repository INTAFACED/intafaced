import {
  type ApprovalRepository,
  type StoredApproval,
  approvalContentHash,
  createMemoryApprovalRepository,
} from '../approval/repository.js';
import {
  BACKTEST_HISTORY_PAGE_MAX,
  BAR_BACKTEST_KEY_PREFIX,
  type Judgement,
  NO_JUDGEMENT,
  type StoredBacktest,
  isBarBacktest,
  presentBacktest,
  readStoredBacktest,
} from '../engine/run.js';
import { type BacktestLake, missingLake } from '../backtest/lake.js';
import {
  type Context,
  type QuantBacktestResult,
  type QuantLifecycle,
  type QuantLiveCheck,
  TRPCError,
  quantSignalRulesSchema,
} from '@intafaced/contracts';
import { DEFAULT_FLOOR_POLICY } from '../risk/rules.js';
import { type DisclosureRepository } from '../disclosure/repository.js';
import { type FeePort, type HistoryPort, missingFees, missingHistory } from '../engine/ports.js';
import { type KeyIdempotencyRepository, createMemoryKeyIdempotencyRepository } from '../key-api/key-api.js';
import { type LakeSettings, type LakeStore } from '../lake/lake.js';
import { type LibraryRepository } from '../library/repository.js';
import { type LifecycleRepository } from '../lifecycle/repository.js';
import { type NotifyRepository, type StoredAlert } from '../notify/repository.js';
import {
  QUANT_APPROVAL_DECIDED,
  QUANT_APPROVAL_HASH_STALE,
  QUANT_APPROVAL_NOT_REVIEWER,
  QUANT_APPROVAL_POLICY_UNSET,
  QUANT_APPROVAL_REQUIRED,
  QUANT_APPROVAL_SELF_REVIEW,
  QUANT_BACKTEST_FILLS_MISSING,
  QUANT_BACKTEST_LAKE_MISSING,
  QUANT_BACKTEST_SURFACE_REFUSED,
  QUANT_BACKTEST_WALK_FORWARD_REQUIRED,
  QUANT_CASH_UNSET,
  QUANT_CLAIM_PNL_UNSET,
  QUANT_CLIENT_STRATEGY_ID_UNSET,
  QUANT_DATABASE_POOL_MAX_UNSET,
  QUANT_DATABASE_URL_UNSET,
  QUANT_DISCLOSURE_UNSET,
  QUANT_DISPUTE_NOT_FOUND,
  QUANT_EDIT_LOCKED,
  QUANT_EDIT_LOCK_UNSET,
  QUANT_EMBED_ORIGINS_UNSET,
  QUANT_ENVIRONMENT_REQUIRED,
  QUANT_ENVIRONMENT_UNKNOWN,
  QUANT_GATE_CRITERIA_UNSET,
  QUANT_IDEMPOTENCY_CONFLICT,
  QUANT_IDEMPOTENCY_KEY_REUSED,
  QUANT_IDEMPOTENCY_KEY_UNSET,
  QUANT_LAKE_RETENTION_UNSET,
  QUANT_LAKE_STORE_UNSET,
  QUANT_LIBRARY_LICENCES_UNSET,
  QUANT_LIBRARY_QUEUE_LIMIT_UNSET,
  QUANT_LISTING_ACCESS_DENIED,
  QUANT_LISTING_CHECK_FAILED,
  QUANT_LISTING_NOT_FOUND,
  QUANT_LISTING_SOURCE_PROTECTED,
  QUANT_LISTING_STALE,
  QUANT_LIST_CURSOR_INVALID,
  QUANT_LIVE_DEPLOY_UNAVAILABLE,
  QUANT_LIVE_DISABLED,
  QUANT_MODERATION_STATE_INVALID,
  QUANT_MONTECARLO_MIN_TRADES_UNSET,
  QUANT_MONTECARLO_RUNS_UNSET,
  QUANT_MONTECARLO_TRADES_INSUFFICIENT,
  QUANT_OPS_RUNS_FROM_UNSET,
  QUANT_OPS_RUNS_LIMIT_UNSET,
  QUANT_OPS_RUNS_TO_UNSET,
  QUANT_PAPER_FEE_UNSET,
  QUANT_PAPER_MANUAL_ORDER_UNSUPPORTED,
  QUANT_PERMISSION_DENIED,
  QUANT_QUOTA_EXCEEDED,
  QUANT_QUOTA_PROFILE_UNSET,
  QUANT_QUOTA_REASON_UNSET,
  QUANT_QUOTA_UNSET,
  QUANT_REALISM_CHECKLIST_UNACCEPTED,
  QUANT_REALISM_CHECKLIST_UNSET,
  QUANT_RELEASE_NOTE_LIMIT_UNSET,
  QUANT_REVIEW_NEEDS_RUN,
  QUANT_RISK_CAP_INVALID,
  QUANT_RISK_CAP_UNSET,
  QUANT_RUN_NOT_FOUND,
  QUANT_RUN_NOT_SIMULATED,
  QUANT_RUN_RESULT_CAP_UNSET,
  QUANT_RUN_RESULT_TOO_LARGE,
  QUANT_RUN_UNFINISHED,
  QUANT_SANDBOX_LIMIT_UNSET,
  QUANT_SANDBOX_MAX_OPS_UNSET,
  QUANT_SANDBOX_MAX_SOURCE_UNSET,
  QUANT_SANDBOX_UNWIRED,
  QUANT_SHARE_NOT_FOUND,
  QUANT_SHARE_RATE_LIMITED,
  QUANT_SHARE_RATE_UNSET,
  QUANT_SHARE_SEQ_UNSET,
  QUANT_SHARE_WINDOW_UNSET,
  QUANT_SIGNAL_RULES_SANDBOX,
  QUANT_SIMULATED_AS_LIVE,
  QUANT_STAGE_TRANSITION_INVALID,
  QUANT_STRATEGY_VERSION_UNSET,
  QUANT_STUDIO_LIST_LIMIT_UNSET,
  QUANT_STUDIO_NOT_FOUND,
  QUANT_STUDIO_RISK_BLOCK_REQUIRED,
  QUANT_TEMPLATE_LIST_LIMIT_UNSET,
  QUANT_TEMPLATE_NOT_FOUND,
  QUANT_VERSION_NOT_FOUND,
  QuantError,
} from '../errors.js';
import { type QuotaRepository } from '../quota/quota.js';
import { RUN_RESULT_MAX_BYTES } from '../runs/limit.js';
import { type RealismChecklist, createLibrary } from '../library/service.js';
import { type RiskRepository } from '../risk/repository.js';
import { type RunLimits, requireRunLimits } from '../sandbox/limits.js';
import { type RunRepository } from '../runs/repository.js';
import { type RunResultBody, type StoredPaperRun } from '../runs/types.js';
import { STUDIO_SERVICE_ALLOWLIST, resolveStudioAccount } from '../studio/scope.js';
import { type SandboxDeps } from '../sandbox/run.js';
import { type ShareRepository } from '../share/repository.js';
import { type StoredCollaborator, type StoredLock, type TeamRepository, grantActive, lockLive } from '../team/repository.js';
import { type StrategyDetail, type StrategyOrganisation, type StrategyRepository, type WriteReceipt } from '../studio/repository.js';
import { type TemplateRepository } from '../templates/repository.js';
import { createMemoryLibraryRepository } from '../library/memory-repository.js';
import { createMemoryLifecycleRepository } from '../lifecycle/memory-repository.js';
import { createMemoryQuota } from '../quota/memory.js';
import { createMemoryRiskRepository } from '../risk/memory-repository.js';
import { createMemoryRunRepository } from '../runs/memory-repository.js';
import { createMemoryTeamRepository } from '../team/memory-repository.js';
import { evaluateGate, gateCriteriaOf } from '../lifecycle/gate.js';
import { liveCheck } from '../live/check.js';
import { openDisclosureRepository } from '../disclosure/open.js';
import { openNotifyRepository } from '../notify/open.js';
import { openStrategyRepository } from '../studio/open.js';
import { openTemplateRepository } from '../templates/open.js';
import { paperView } from '../paper/view.js';
import { parseAmount } from '@intafaced/ledger-client/money';
import { z } from 'zod';

export const simulatedStamp = z.object({
  environment: z.enum(['paper', 'backtest', 'shadow']),
  kind: z.enum(['paper', 'simulated']),
  claimLabel: z.enum(['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance']),
  live: z.literal(false),
  simulated: z.literal(true),
});

export const environmentInput = z.object({
  environment: z.string().optional().nullable(),
  presentedAs: z.string().optional().nullable(),
});

export const decimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'amounts are decimal strings with at most 18 decimal places');

export const language = z.enum(['javascript', 'typescript', 'python']);

export const fillSchema = z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string(),
  qty: z.string(),
  price: z.string(),
  venue: z.literal('internal'),
});

export const rejectReason = z.enum([
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
export const orderEventSchema = z.object({
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
  reason: rejectReason.optional(),
  notional: z.string().optional(),
  fee: z.string().optional(),
  cash: z.string().optional(),
  position: z.string().optional(),
  reserved: z.string().optional(),
});

/** One leg of a reversal, each checked on its own (AL-orders-02). */
export const reverseLegSchema = z.object({
  leg: z.enum(['close', 'open']),
  side: z.enum(['buy', 'sell']),
  symbol: z.string(),
  qty: z.string(),
  checked: z.literal(true),
  outcome: z.enum(['filled', 'refused']),
  order: z.string(),
  reason: rejectReason.nullable(),
});

export const runOutput = z
  .object({
    ok: z.literal(true),
    language,
    logs: z.array(z.string()),
    cash: z.string(),
    pnl: z.string(),
    fills: z.array(fillSchema),
    positions: z.array(z.object({ symbol: z.string(), qty: z.string() })),
    events: z.array(orderEventSchema),
    legs: z.array(reverseLegSchema),
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
  .merge(simulatedStamp);

/** The head an organise sets: a name, one level of folder (blank is the root) and a description, each checked by name. */
export function organisationOf(input: { name?: unknown; folder?: unknown; description?: unknown }): StrategyOrganisation {
  const text = (field: 'name' | 'folder' | 'description', value: unknown): string => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new QuantError('quant.params_invalid', `${field} — must be text`);
    return value.trim();
  };
  const name = text('name', input.name);
  if (!name) throw new QuantError('quant.params_invalid', 'name — the strategy name is unset');
  if (name.length > 128) throw new QuantError('quant.params_invalid', 'name — longer than 128 characters');
  const folder = text('folder', input.folder);
  if (folder.length > 40) throw new QuantError('quant.params_invalid', 'folder — longer than 40 characters');
  if (folder.includes('/')) throw new QuantError('quant.params_invalid', 'folder — one level only, without a slash');
  const description = text('description', input.description);
  if (description.length > 500) throw new QuantError('quant.params_invalid', 'description — longer than 500 characters');
  return { name, folder, description };
}

export function toTrpc(err: unknown): never {
  if (err instanceof QuantError) {
    const code =
      err.code === QUANT_STUDIO_NOT_FOUND ||
      err.code === QUANT_RUN_NOT_FOUND ||
      err.code === QUANT_SHARE_NOT_FOUND ||
      err.code === QUANT_VERSION_NOT_FOUND ||
      err.code === QUANT_TEMPLATE_NOT_FOUND ||
      err.code === QUANT_LISTING_NOT_FOUND ||
      err.code === QUANT_DISPUTE_NOT_FOUND
        ? 'NOT_FOUND'
        : err.code === QUANT_PERMISSION_DENIED ||
            err.code === QUANT_LISTING_ACCESS_DENIED ||
            err.code === QUANT_LISTING_SOURCE_PROTECTED ||
            err.code === QUANT_APPROVAL_SELF_REVIEW ||
            err.code === QUANT_APPROVAL_NOT_REVIEWER
          ? 'FORBIDDEN'
          : err.code === QUANT_EDIT_LOCKED ||
              err.code === QUANT_LISTING_STALE ||
              err.code === QUANT_MODERATION_STATE_INVALID ||
              err.code === QUANT_IDEMPOTENCY_KEY_REUSED ||
              err.code === QUANT_APPROVAL_HASH_STALE ||
              err.code === QUANT_APPROVAL_DECIDED
            ? 'CONFLICT'
            : err.code === QUANT_SANDBOX_UNWIRED ||
                err.code === QUANT_SANDBOX_MAX_OPS_UNSET ||
                err.code === QUANT_SANDBOX_MAX_SOURCE_UNSET ||
                err.code === QUANT_PAPER_FEE_UNSET ||
                err.code === QUANT_BACKTEST_LAKE_MISSING ||
                err.code === QUANT_BACKTEST_FILLS_MISSING ||
                err.code === QUANT_STUDIO_LIST_LIMIT_UNSET ||
                err.code === QUANT_TEMPLATE_LIST_LIMIT_UNSET ||
                err.code === QUANT_RUN_UNFINISHED ||
                err.code === QUANT_RUN_NOT_SIMULATED ||
                err.code === QUANT_RUN_RESULT_CAP_UNSET ||
                err.code === QUANT_RUN_RESULT_TOO_LARGE ||
                err.code === QUANT_CLAIM_PNL_UNSET ||
                err.code === QUANT_DISCLOSURE_UNSET ||
                err.code === QUANT_EMBED_ORIGINS_UNSET ||
                err.code === QUANT_SHARE_RATE_UNSET ||
                err.code === QUANT_RELEASE_NOTE_LIMIT_UNSET ||
                err.code === QUANT_SHARE_WINDOW_UNSET ||
                err.code === QUANT_SHARE_RATE_LIMITED ||
                err.code === QUANT_SIGNAL_RULES_SANDBOX ||
                err.code === QUANT_QUOTA_UNSET ||
                err.code === QUANT_QUOTA_EXCEEDED ||
                err.code === QUANT_QUOTA_PROFILE_UNSET ||
                err.code === QUANT_SANDBOX_LIMIT_UNSET ||
                err.code === QUANT_GATE_CRITERIA_UNSET ||
                err.code === QUANT_RISK_CAP_UNSET ||
                err.code === QUANT_STAGE_TRANSITION_INVALID ||
                err.code === QUANT_EDIT_LOCK_UNSET ||
                err.code === QUANT_PAPER_MANUAL_ORDER_UNSUPPORTED ||
                err.code === QUANT_LIBRARY_LICENCES_UNSET ||
                err.code === QUANT_REALISM_CHECKLIST_UNSET ||
                err.code === QUANT_REALISM_CHECKLIST_UNACCEPTED ||
                err.code === QUANT_LISTING_CHECK_FAILED ||
                err.code === QUANT_REVIEW_NEEDS_RUN ||
                err.code === QUANT_LIBRARY_QUEUE_LIMIT_UNSET ||
                err.code === QUANT_LIVE_DISABLED ||
                err.code === QUANT_LIVE_DEPLOY_UNAVAILABLE ||
                err.code === QUANT_MONTECARLO_RUNS_UNSET ||
                err.code === QUANT_MONTECARLO_MIN_TRADES_UNSET ||
                err.code === QUANT_MONTECARLO_TRADES_INSUFFICIENT ||
                err.code === QUANT_LAKE_STORE_UNSET ||
                err.code === QUANT_LAKE_RETENTION_UNSET ||
                err.code === QUANT_APPROVAL_POLICY_UNSET ||
                err.code === QUANT_APPROVAL_REQUIRED ||
                err.code === 'quant.venue_vault_unset'
              ? 'PRECONDITION_FAILED'
              : err.code === QUANT_DATABASE_URL_UNSET || err.code === QUANT_DATABASE_POOL_MAX_UNSET
                ? 'PRECONDITION_FAILED'
                : err.code === QUANT_STUDIO_RISK_BLOCK_REQUIRED ||
                    err.code === QUANT_BACKTEST_WALK_FORWARD_REQUIRED ||
                    err.code === QUANT_BACKTEST_SURFACE_REFUSED ||
                    err.code === QUANT_ENVIRONMENT_REQUIRED ||
                    err.code === QUANT_ENVIRONMENT_UNKNOWN ||
                    err.code === QUANT_SIMULATED_AS_LIVE ||
                    err.code === QUANT_CASH_UNSET ||
                    err.code === QUANT_CLIENT_STRATEGY_ID_UNSET ||
                    err.code === QUANT_IDEMPOTENCY_KEY_UNSET ||
                    err.code === QUANT_IDEMPOTENCY_CONFLICT ||
                    err.code === QUANT_STRATEGY_VERSION_UNSET ||
                    err.code === QUANT_LIST_CURSOR_INVALID ||
                    err.code === QUANT_OPS_RUNS_LIMIT_UNSET ||
                    err.code === QUANT_OPS_RUNS_FROM_UNSET ||
                    err.code === QUANT_OPS_RUNS_TO_UNSET ||
                    err.code === QUANT_RISK_CAP_INVALID
                  ? 'BAD_REQUEST'
                  : err.code === 'quant.sandbox_timeout'
                    ? 'TIMEOUT'
                    : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

export const studioBlock = z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string().min(1).max(32),
  qty: decimal,
});

export const studioRisk = z
  .object({
    maxDrawdown: z.string().optional(),
    maxNotional: z.string().optional(),
    kill: z.string().optional(),
  })
  .optional();

export const strategyVersionRecord = z
  .object({
    version: z.number().int().positive(),
    createdAt: z.string(),
    name: z.string(),
    language: z.literal('javascript'),
    source: z.string(),
    cash: z.string(),
    blocks: z.array(studioBlock),
    modules: quantSignalRulesSchema.nullable(),
    risk: z.object({
      maxDrawdown: z.string(),
      maxNotional: z.string(),
      kill: z.string(),
    }),
    // A default, because a version stored before release notes existed was replayed without one.
    releaseNote: z.string().default(''),
  })
  .merge(simulatedStamp);

export const strategyHead = strategyVersionRecord.extend({
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

export const strategyDetail = strategyHead.extend({
  versions: z.array(strategyVersionRecord),
});

/**
 * One strategy as `studio.get` answers it, with what the account's live approval policy allows (J-algo-dev-16 #4): the
 * live runner (svc-trade) starts a version only when the policy is off or that version holds a current approval.
 */
export const strategyDetailForLive = strategyDetail.extend({
  liveApproval: z.object({ required: z.boolean(), approvedVersions: z.array(z.number().int().positive()) }),
});

export const costEvidence = z.object({
  kind: z.string(),
  source: z.string(),
});

export const costBreakdown = z
  .object({
    fees: costEvidence.nullable(),
    slippage: costEvidence.nullable(),
    latency: costEvidence.nullable(),
  })
  .nullable();

export const runDetailOutput = z.object({
  runId: z.string(),
  kind: z.enum(['backtest', 'sandbox', 'paper']),
  strategyId: z.string().nullable(),
  strategyVersion: z.number().int().positive().nullable(),
  started: z.string(),
  finished: z.string().nullable(),
  outcome: z.string().nullable(),
  equityCurve: z.array(z.object({ ts: z.string(), equity: decimal })).nullable(),
  trades: z.array(z.object({ ts: z.string(), symbol: z.string(), qty: decimal, price: decimal })).nullable(),
  costs: costBreakdown,
  pnl: decimal.nullable(),
});

export function sandboxBody(ran: {
  pnl: string;
  environment: RunResultBody['environment'];
  kind: RunResultBody['kind'];
  claimLabel: RunResultBody['claimLabel'];
}): RunResultBody {
  return {
    equityCurve: null,
    trades: null,
    costs: null,
    pnl: ran.pnl,
    simulated: true,
    live: false,
    environment: ran.environment,
    kind: ran.kind,
    claimLabel: ran.claimLabel,
  };
}

export const backtestOutput = z
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
    inSample: z.object({ fillCount: z.number().int(), notional: decimal }),
    outOfSample: z.object({ fillCount: z.number().int(), notional: decimal }),
    claimLabel: z.literal('Historical simulation — not a forecast'),
    outOfSampleLabel: z.string(),
    strategyVersion: z.number().int().positive(),
  })
  .merge(simulatedStamp);

export interface QuantRouterDeps extends SandboxDeps {
  readonly lake?: BacktestLake;
  /** The live approval policy and approvals (J-algo-dev-16 #4). Omitted: an in-memory store. */
  readonly approvals?: ApprovalRepository;
  /** Monte Carlo owner values (J-algo-dev-16 #3): resampled paths per run and the fewest round trips. Blank refuses. */
  readonly monteCarlo?: { readonly runs: number | null; readonly minTrades: number | null };
  /** The market data lake (J-algo-dev-16 #2). Omitted, or with no symbols or interval: `quant.lake_store_unset`. */
  readonly dataLake?: { readonly store: LakeStore; readonly settings: LakeSettings };
  /** The bar backtest's closed-candle read. Omitted refuses `quant.backtest_lake_missing`. */
  readonly history?: HistoryPort;
  /** The published fee schedule read. Omitted refuses `quant.cost_unset` naming fees. */
  readonly fees?: FeePort;
  /** Decides only whether a backtest window has closed, and where a rolling holdout begins. */
  readonly now?: () => number;
  /** The owner's out-of-sample criteria and holdout. Omitted, every one is blank: verdicts read inconclusive by name. */
  readonly judgement?: Judgement;
  /**
   * Services allowed to name an account. Defaults to none.
   * `src/index.ts` does not set this.
   */
  readonly studioServiceAllowlist?: readonly string[];
  /** Omitted only when DATABASE_URL is unset: studio and backtest then refuse by name. */
  readonly strategies?: StrategyRepository;
  /** Omitted in tests: an in-memory run log. Production passes Postgres. */
  readonly runs?: RunRepository;
  /** Where a key's backtest start keeps its `Idempotency-Key` (J-algo-dev-14). Omitted: in memory (tests). */
  readonly keyIdempotency?: KeyIdempotencyRepository;
  /** Omitted refuses by naming the missing database. Production passes Postgres. */
  readonly disclosure?: DisclosureRepository;
  /** Omitted refuses by naming the missing database. Production passes Postgres. */
  readonly templates?: TemplateRepository;
  /**
   * Quota profiles and assignments (AL-limits-01), read by `quota.get` and written by `ops.quota.*`. The same store's
   * gate is passed to the strategy and run repositories, which enforce it. Omitted in unit tests: no profile applies.
   */
  readonly quota?: QuotaRepository;
  /**
   * Strategy notification channels and fill alerts (AL-live-06, AL-alerts-01). Omitted refuses by naming the missing
   * database; unit tests pass the in-memory store.
   */
  readonly notify?: NotifyRepository;
  /** A strategy's risk screen (AL-risk-01). */
  readonly risk?: RiskRepository;
  /** Strategy teams, edit locks and support grants (J-algo-dev-08). Omitted in unit tests: an in-memory store with no team. */
  readonly team?: TeamRepository;
  /**
   * The strategy library (J-algo-dev-09) and the owner's licence list and realism checklist; either blank refuses
   * publishing by name. Omitted in unit tests: an in-memory store with both blank.
   */
  readonly library?: {
    readonly repository: LibraryRepository;
    readonly licences: readonly string[] | null;
    readonly checklist: RealismChecklist | null;
  };
  /** `QUANT_EDIT_LOCK_SECONDS`: how long an edit lock lasts. Null is blank: taking a lock refuses `quant.edit_lock_unset`. */
  readonly editLockSeconds?: number | null;
  /**
   * The lifecycle store (AL-lifecycle-01): stage rows, gate decisions and the owner criteria an operator sets at
   * runtime. Omitted in unit tests: an in-memory store with nothing set.
   */
  readonly lifecycle?: LifecycleRepository;
  /** Omitted uses the published byte cap. Pass null only to prove the cap refuses. */
  readonly runResultCap?: number | null;
  /**
   * The owner's cap on a version's release note, in characters (AL-editor-01). Omitted or null, a save with a note
   * refuses `quant.release_note_limit_unset`; a save without one still saves.
   */
  readonly releaseNoteMax?: number | null;
  /**
   * Share links (AL-report-03). Omitted, the rate and the window are blank and every share call refuses by name.
   * A repository is still required once the rate is set; production passes Postgres.
   */
  readonly share?: {
    readonly repository: ShareRepository;
    readonly rate: number | null;
    readonly windowSec: number | null;
    readonly embedOrigins: readonly string[] | null;
    readonly now?: () => number;
  };
}

export const strategyMetadata = z.object({
  id: z.string(),
  accountId: z.string().guid().nullable(),
  name: z.string(),
  language: z.literal('javascript'),
  environment: z.enum(['paper', 'backtest', 'shadow']),
  kind: z.enum(['paper', 'simulated']),
  claimLabel: z.enum(['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance']),
  live: z.literal(false),
  simulated: z.literal(true),
});

export const accountField = { accountId: z.string().guid().optional() };
export const writeKeyField = { idempotencyKey: z.string().optional().nullable() };
export const clientIdField = { clientStrategyId: z.string().optional().nullable() };

/** A stored alert as the screen reads it. */
export function alertView(row: StoredAlert) {
  return {
    alertId: row.id,
    strategyId: row.strategyId,
    strategyVersion: row.strategyVersion,
    event: 'fill' as const,
    template: row.template,
    createdAt: row.createdAt,
  };
}

export function missingStrategy(): never {
  throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
}

/** Everything the area routers share: the deps with their defaults, and the helpers that read them. */
export function createQuantCore(deps: QuantRouterDeps) {
  const strategies = deps.strategies ?? openStrategyRepository({}).repository;
  const keyIdempotency = deps.keyIdempotency ?? createMemoryKeyIdempotencyRepository();
  const runs = deps.runs ?? createMemoryRunRepository('runResultCap' in deps ? deps.runResultCap : RUN_RESULT_MAX_BYTES);
  const lake = deps.lake ?? missingLake();
  const history = deps.history ?? missingHistory();
  const fees = deps.fees ?? missingFees();
  const now = deps.now ?? (() => Date.now());
  const judgement = deps.judgement ?? NO_JUDGEMENT;
  const disclosure = deps.disclosure ?? openDisclosureRepository({}).repository;
  const templates = deps.templates ?? openTemplateRepository({}).repository;
  const quota = deps.quota ?? createMemoryQuota({ defaultProfile: null }).repository;
  const notify = deps.notify ?? openNotifyRepository({}).repository;
  const risk = deps.risk ?? createMemoryRiskRepository();
  const lifecycle = deps.lifecycle ?? createMemoryLifecycleRepository();

  /** The account's strategy, not in the bin; anything else is not found. */
  async function liveStrategy(accountId: string, strategyId: string) {
    const found = await strategies.get({ accountId, id: strategyId });
    if (!found || found.deletedAt) missingStrategy();
    return found;
  }
  const newestVersion = (strategy: { readonly versions: readonly { readonly version: number }[] }) =>
    Math.max(...strategy.versions.map((row) => row.version));
  /** The strategy's equity-stop floor for a backtest, or null while the risk screen leaves it blank. */
  async function equityStopOf(accountId: string, strategyId: string) {
    const stored = await risk.get({ accountId, strategyId });
    if (!stored?.caps.equityFloor) return null;
    return { floor: parseAmount(stored.caps.equityFloor), policy: stored.floorPolicy ?? DEFAULT_FLOOR_POLICY };
  }

  const approvals = deps.approvals ?? createMemoryApprovalRepository();

  /** The hash an approval of one version binds to now: its rules and the strategy's risk settings as stored. */
  async function approvalHashOf(found: StrategyDetail, strategyVersion: number): Promise<string> {
    const v = found.versions.find((row) => row.version === strategyVersion);
    if (!v) missingStrategy();
    const stored = await risk.get({ accountId: found.accountId, strategyId: found.id });
    return approvalContentHash({
      version: { source: v.source, cash: v.cash, blocks: v.blocks, modules: v.modules, risk: v.risk },
      risk: stored ? { caps: stored.caps, floorPolicy: stored.floorPolicy ?? null } : null,
    });
  }

  /** An approval counts for live use while its decision is approved and its hash is the version's hash now. */
  async function approvedVersionsOf(found: StrategyDetail, rows: readonly StoredApproval[]): Promise<number[]> {
    const out: number[] = [];
    for (const row of rows) {
      if (row.decision !== 'approved' || out.includes(row.strategyVersion)) continue;
      if (!found.versions.some((v) => v.version === row.strategyVersion)) continue;
      if ((await approvalHashOf(found, row.strategyVersion)) === row.contentHash) out.push(row.strategyVersion);
    }
    return out;
  }

  /** The owner's strategy, or one shared with the caller; the caller's place on it. Anyone else: not found. */
  async function approvalStrategy(
    callerId: string,
    strategyId: string,
  ): Promise<{ found: StrategyDetail; member: StoredCollaborator | null }> {
    const own = await strategies.get({ accountId: callerId, id: strategyId });
    if (own && !own.deletedAt) return { found: own, member: null };
    const { member, found } = await sharedStrategy(callerId, strategyId);
    return { found, member };
  }

  async function approvalStateOf(callerId: string, strategyId: string) {
    const { found, member } = await approvalStrategy(callerId, strategyId);
    const [policy, rows] = await Promise.all([approvals.policy(found.accountId), approvals.approvals(found.id)]);
    const contentHash = await approvalHashOf(found, found.version);
    const approved = await approvedVersionsOf(found, rows);
    const allowed = policy?.required !== true || approved.includes(found.version);
    const view = [];
    for (const row of rows) {
      const live = found.versions.some((v) => v.version === row.strategyVersion);
      view.push({
        approvalId: row.id,
        strategyVersion: row.strategyVersion,
        contentHash: row.contentHash,
        requester: row.requester,
        reviewer: row.reviewer,
        decision: row.decision,
        reason: row.reason,
        requestedAt: row.requestedAt,
        decidedAt: row.decidedAt,
        current: live && (await approvalHashOf(found, row.strategyVersion)) === row.contentHash,
      });
    }
    return {
      strategyId: found.id,
      ownerId: found.accountId,
      policy: { required: policy ? policy.required : null, setAt: policy?.setAt ?? null },
      version: found.version,
      contentHash,
      live: { allowed, code: allowed ? null : QUANT_APPROVAL_REQUIRED },
      approvals: view,
      canDecide: member !== null,
    };
  }

  /**
   * One version's lifecycle (AL-lifecycle-01): its stage rows and gate decisions, and the gate as it reads now, from this
   * account's own stored backtests and paper runs of exactly this version and the owner's stored criteria. Nothing the
   * caller sends is read, and no Preview room's sample windows can count: they are never stored as runs.
   */
  async function lifecycleOf(accountId: string, strategyId: string, strategyVersion: number): Promise<QuantLifecycle> {
    const found = await strategies.get({ accountId, id: strategyId });
    const version = found && !found.deletedAt ? found.versions.find((row) => row.version === strategyVersion) : undefined;
    if (!found || !version) missingStrategy();
    const [rows, stored, page, paper] = await Promise.all([
      lifecycle.criteria(),
      lifecycle.of({ accountId, strategyId: found.id, strategyVersion }),
      runs.history({
        userId: accountId,
        kind: 'backtest',
        keyPrefix: BAR_BACKTEST_KEY_PREFIX,
        limit: BACKTEST_HISTORY_PAGE_MAX,
        cursor: null,
        strategyId: found.id,
      }),
      runs.paperRuns({ userId: accountId, strategyId: found.id, limit: 10_000 }),
    ]);
    const backtests: QuantBacktestResult[] = [];
    for (const row of page.runs) {
      if (row.strategyVersion !== strategyVersion || !row.finished || row.outcome !== 'ok') continue;
      const full = await runs.get({ userId: accountId, id: row.id });
      const result = full && isBarBacktest(full) ? readStoredBacktest(full.response) : null;
      if (result) backtests.push(presentBacktest(result, full!.id));
    }
    const reading = evaluateGate({
      criteria: gateCriteriaOf(rows),
      backtests,
      paper: paper
        .filter((row) => row.run.strategyVersion === strategyVersion)
        .map((row) => ({ runId: row.run.id, startedAt: row.run.started, stoppedAt: row.run.finished })),
      risk: version.risk,
      nowMs: now(),
    });
    const last = stored.stages[stored.stages.length - 1];
    return {
      strategyId: found.id,
      strategyVersion,
      stage: last ? last.to : reading.derivedStage,
      stages: [...stored.stages],
      decisions: [...stored.decisions],
      gate: { approved: reading.approved, unset: reading.unset, checks: reading.checks },
      asOf: new Date(now()).toISOString(),
    };
  }
  /**
   * The deploy wizard's compile check of one version (AL-live-02; J-algo-dev-06 #6), with the platform's live switch as
   * the owner set it now (`live.enabled`; blank, unreadable or anything but `on` is off). Writes nothing.
   */
  async function liveCheckOf(accountId: string, strategyId: string, strategyVersion: number): Promise<QuantLiveCheck> {
    const found = await strategies.get({ accountId, id: strategyId });
    const version = found && !found.deletedAt ? found.versions.find((row) => row.version === strategyVersion) : undefined;
    if (!found || !version) missingStrategy();
    const reading = liveCheck(version);
    return {
      strategyId: found.id,
      strategyVersion,
      name: version.name,
      plan: reading.plan,
      orderTypes: reading.orderTypes,
      compiles: reading.compiles,
      liveEnabled: await liveSwitchOn(),
      asOf: new Date(now()).toISOString(),
    };
  }

  /** The platform's live switch: on only when an operator stored `on`. Any failure to read it is off. */
  async function liveSwitchOn(): Promise<boolean> {
    try {
      return (await lifecycle.criteria()).some((row) => row.name === 'live.enabled' && row.value === 'on');
    } catch {
      return false;
    }
  }

  /** A paper run as the screen reads it, from its own strategy version. */
  async function presentPaper(accountId: string, paper: StoredPaperRun) {
    const found = await strategies.get({ accountId, id: paper.run.strategyId ?? '' });
    const version = found?.versions.find((row) => row.version === paper.run.strategyVersion);
    if (!found || !version) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
    return paperView(
      paper,
      { id: found.id, version: version.version, modules: version.modules, risk: version.risk },
      { fees, history },
      now(),
    );
  }
  /**
   * The sandbox limits a run of this account meets (J-algo-dev-12): the applied plan's, each required. Called before the
   * run is recorded or started, so a blank limit refuses by name and nothing runs. A call with no signed account reads
   * the default plan (the nil id is never an account).
   */
  async function runLimitsFor(accountId: string | null): Promise<RunLimits> {
    const applied = await quota.applied(accountId ?? '00000000-0000-0000-0000-000000000000');
    return requireRunLimits(applied, applied ? await quota.sandboxLimits(applied.name) : []);
  }
  /** Sandbox deps for one run, with that run's plan limits. */
  function runDeps(run: RunLimits): SandboxDeps {
    return { ...deps, limits: { ...deps.limits, run } };
  }
  /** The reason an operator gives for a quota write: required, so every audit row says why. */
  function quotaReason(raw: string): string {
    const reason = raw.trim();
    if (!reason) throw new QuantError(QUANT_QUOTA_REASON_UNSET, 'reason — a quota change needs a reason');
    return reason;
  }
  const shares = deps.share?.repository;
  const releaseNoteMax = deps.releaseNoteMax ?? null;
  /** A version's release note: blank is no note; a note needs the owner's cap, and is refused over it. */
  function releaseNoteOf(raw: string | undefined): string {
    const note = raw?.trim() ?? '';
    if (!note) return '';
    if (releaseNoteMax === null) {
      throw new QuantError(QUANT_RELEASE_NOTE_LIMIT_UNSET, 'releaseNote — the length limit for a release note is not set');
    }
    if (note.length > releaseNoteMax) {
      throw new QuantError('quant.params_invalid', `releaseNote — longer than ${releaseNoteMax} characters`);
    }
    return note;
  }
  const shareRate = deps.share?.rate ?? null;
  const shareWindowSec = deps.share?.windowSec ?? null;
  const embedOrigins = deps.share?.embedOrigins ?? null;
  const shareNow = deps.share?.now ?? (() => Date.now());
  const studioServices = new Set(deps.studioServiceAllowlist ?? STUDIO_SERVICE_ALLOWLIST);

  async function replayOf(accountId: string, idempotencyKey: string | null | undefined): Promise<WriteReceipt | null> {
    const key = idempotencyKey?.trim() ?? '';
    if (!key) return null;
    return strategies.replay(accountId, key);
  }

  function accountOf(ctx: Context, bodyAccountId: string | undefined): string {
    return resolveStudioAccount(ctx, bodyAccountId, studioServices);
  }

  async function currentDisclosure() {
    const found = await disclosure.current();
    return found
      ? { published: true as const, version: found.version, text: found.text, publishedAt: found.publishedAt }
      : { published: false as const };
  }

  function requireShareLimits(): { readonly rate: number; readonly windowMs: number } {
    if (shareRate === null || !Number.isInteger(shareRate) || shareRate < 0) {
      throw new QuantError(QUANT_SHARE_RATE_UNSET, 'share rate — the public read limit is not set');
    }
    if (shareWindowSec === null || !Number.isInteger(shareWindowSec) || shareWindowSec < 1) {
      throw new QuantError(QUANT_SHARE_WINDOW_UNSET, 'share window — the public read window is not set');
    }
    if (!shares) throw new QuantError(QUANT_DATABASE_URL_UNSET, 'DATABASE_URL is unset');
    return { rate: shareRate, windowMs: shareWindowSec * 1000 };
  }

  function requireSeq(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new QuantError(QUANT_SHARE_SEQ_UNSET, 'seq — the number of links the screen read is unset');
    }
    return value;
  }

  function sharePath(token: string): string {
    return `/quant/share/${token}`;
  }

  function embedOf(token: string | null): {
    embed: { snippet: string; origins: string[] } | null;
    embedRefusal: 'quant.embed_origins_unset' | null;
  } {
    if (embedOrigins === null || embedOrigins.length === 0) {
      return { embed: null, embedRefusal: QUANT_EMBED_ORIGINS_UNSET };
    }
    if (!token) return { embed: null, embedRefusal: null };
    const origins = [...embedOrigins];
    return {
      embed: { snippet: `<iframe src="${sharePath(token)}" title="Historical simulation — not a forecast"></iframe>`, origins },
      embedRefusal: null,
    };
  }

  /** The caller's own finished bar backtest. Anything else, including another account's run, is not found. */
  async function ownedBar(accountId: string, runId: string): Promise<{ id: string; stored: StoredBacktest }> {
    const row = await runs.get({ userId: accountId, id: runId });
    const stored = row && row.finished && row.outcome === 'ok' && isBarBacktest(row) ? readStoredBacktest(row.response) : null;
    if (!row || !stored) throw new QuantError(QUANT_RUN_NOT_FOUND, 'run not found');
    return { id: row.id, stored };
  }

  /** The caller's own, undeleted strategy at a version that exists. Anything else reads as not found. */
  async function ownedStrategyVersion(accountId: string, strategyId: string, strategyVersion: number): Promise<void> {
    const found = await strategies.get({ accountId, id: strategyId });
    if (!found || found.deletedAt || !found.versions.some((row) => row.version === strategyVersion)) missingStrategy();
  }

  const team = deps.team ?? createMemoryTeamRepository();
  const library = createLibrary({
    library: deps.library?.repository ?? createMemoryLibraryRepository(),
    strategies,
    runs,
    licences: deps.library?.licences ?? null,
    checklist: deps.library?.checklist ?? null,
    queuePageSize: async () => (await lifecycle.criteria()).find((row) => row.name === 'library.queuePageSize')?.value ?? null,
    now,
  });
  const editLockSeconds = deps.editLockSeconds ?? null;

  /** The caller's own, undeleted strategy. Anything else reads as not found. */
  async function ownStrategy(accountId: string, strategyId: string): Promise<StrategyDetail> {
    const found = await strategies.get({ accountId, id: strategyId });
    if (!found || found.deletedAt) missingStrategy();
    return found;
  }

  function lockView(lock: StoredLock | null, accountId: string) {
    const at = new Date(now());
    return lockLive(lock, at)
      ? { held: true, holderId: lock.holderId, mine: lock.holderId === accountId, expiresAt: lock.expiresAt }
      : { held: false, holderId: null, mine: false, expiresAt: null };
  }

  /** The owner's view of a strategy's team. */
  async function teamOf(ownerId: string, strategyId: string) {
    const at = new Date(now());
    const [members, lock, grants, reads] = await Promise.all([
      team.collaborators(strategyId),
      team.lock(strategyId),
      team.grants(strategyId),
      team.reads(strategyId),
    ]);
    return {
      strategyId,
      ownerId,
      collaborators: members.map((row) => ({
        memberId: row.memberId,
        role: row.role,
        liveControl: row.liveControl,
        addedAt: row.addedAt,
        updatedAt: row.updatedAt,
      })),
      lock: lockView(lock, ownerId),
      grants: grants.map((row) => ({ grantId: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt, active: grantActive(row, at) })),
      reads: reads.map((row) => ({ readAt: row.readAt, reader: row.reader, granted: row.granted })),
      asOf: at.toISOString(),
    };
  }

  /** A strategy shared with the caller, with the caller's permission. Not shared (or removed, or deleted) is not found. */
  async function sharedStrategy(accountId: string, strategyId: string): Promise<{ member: StoredCollaborator; found: StrategyDetail }> {
    const member = await team.membership({ strategyId, memberId: accountId });
    if (!member) missingStrategy();
    const found = await strategies.get({ accountId: member.ownerId, id: strategyId });
    if (!found || found.deletedAt) missingStrategy();
    return { member, found };
  }

  async function sharedView(accountId: string, member: StoredCollaborator, found: StrategyDetail) {
    return {
      strategyId: found.id,
      ownerId: found.accountId,
      role: member.role,
      liveControl: member.liveControl,
      name: found.name,
      version: found.version,
      source: found.source,
      releaseNote: found.releaseNote,
      versions: found.versions.map((row) => ({
        version: row.version,
        name: row.name,
        createdAt: row.createdAt,
        releaseNote: row.releaseNote,
      })),
      lock: lockView(await team.lock(found.id), accountId),
    };
  }

  /** The owner, or a teammate with edit, may hold the lock. Anyone else: not found, or view only. */
  async function editableBy(accountId: string, strategyId: string): Promise<string> {
    const own = await strategies.get({ accountId, id: strategyId });
    if (own && !own.deletedAt) return own.id;
    const { member, found } = await sharedStrategy(accountId, strategyId);
    if (member.role !== 'edit') {
      throw new QuantError(QUANT_PERMISSION_DENIED, 'this strategy is shared with you to view only, so you cannot take its edit lock');
    }
    return found.id;
  }

  /** Takes or renews the caller's lock, or refuses naming when another person's lock lapses. */
  async function takeEditLock(strategyId: string, holderId: string): Promise<StoredLock> {
    if (editLockSeconds === null) {
      throw new QuantError(QUANT_EDIT_LOCK_UNSET, 'QUANT_EDIT_LOCK_SECONDS — how long an edit lock lasts is not set');
    }
    const attempt = await team.takeLock({ strategyId, holderId, at: new Date(now()), ttlMs: editLockSeconds * 1000 });
    if (!attempt.taken) {
      throw new QuantError(
        QUANT_EDIT_LOCKED,
        `another person holds the edit lock until ${attempt.lock.expiresAt}; take it after it lapses`,
      );
    }
    return attempt.lock;
  }

  /** The owner's own save waits while a teammate's live lock holds the strategy. */
  async function refuseWhileLocked(accountId: string, strategyId: string): Promise<void> {
    const lock = await team.lock(strategyId);
    if (lockLive(lock, new Date(now())) && lock.holderId !== accountId) {
      throw new QuantError(QUANT_EDIT_LOCKED, `another person holds the edit lock until ${lock.expiresAt}; take it after it lapses`);
    }
  }

  return {
    deps,
    strategies,
    keyIdempotency,
    runs,
    lake,
    history,
    fees,
    now,
    judgement,
    disclosure,
    templates,
    quota,
    notify,
    risk,
    lifecycle,
    liveStrategy,
    newestVersion,
    equityStopOf,
    approvals,
    approvalHashOf,
    approvedVersionsOf,
    approvalStrategy,
    approvalStateOf,
    lifecycleOf,
    liveCheckOf,
    liveSwitchOn,
    presentPaper,
    runLimitsFor,
    runDeps,
    quotaReason,
    shares,
    releaseNoteMax,
    releaseNoteOf,
    shareRate,
    shareWindowSec,
    embedOrigins,
    shareNow,
    studioServices,
    replayOf,
    accountOf,
    currentDisclosure,
    requireShareLimits,
    requireSeq,
    sharePath,
    embedOf,
    ownedBar,
    ownedStrategyVersion,
    team,
    library,
    editLockSeconds,
    ownStrategy,
    lockView,
    teamOf,
    sharedStrategy,
    sharedView,
    editableBy,
    takeEditLock,
    refuseWhileLocked,
  };
}

export type QuantCore = ReturnType<typeof createQuantCore>;
