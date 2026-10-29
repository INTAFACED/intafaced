import { z } from 'zod';
import { envScreeningList, SHIPPED_BUSINESS_BLOCKS } from '@intafaced/config';
import { router, publicProcedure, scopedProcedure, TRPCError, forwardedPrincipalHeaders } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { AgentError, assertOpsSessionsLimit, assertSessionLogPageLimit, assertSessionMineLimit, assertUserLogPageLimit } from './errors.js';
import { requireSettleService } from './settle-hmac.js';
import type { AuditedAction } from './fleet/audit.js';
import type { ModelGateway } from './gateway/gateway.js';
import type { UsageMeter } from './metering/meter.js';
import type { AgentRuntime } from './runtime.js';
import { rankFixtures } from './scanner/rank.js';
import { rankLiveFromTickers } from './scanner/rank-live.js';
import { scannerAgentGuardrail } from './scanner/guardrail.js';
import { invokeScannerDataTool } from './scanner/data-tools.js';
import { scannerTierGate } from './scanner/tier-gate.js';
import { runScannerRankSession } from './scanner/session-run.js';
import { resolveScannerSignalInputsLaw, SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL } from './scanner/signal-inputs-law.js';
import { describeScannerPolicy } from './scanner/policy.js';
import { navigatorGrounded } from './navigator/grounded.js';
import { selectNavigatorTools } from './navigator/tool-select.js';
import { navigatorAgentGuardrail } from './navigator/guardrail.js';
import { invokeNavigatorDataTool } from './navigator/data-tools.js';
import { effectiveNavigatorTradePlane } from './navigator/trade-plane-env.js';
import { readLiveNavigatorMarkets, type NavigatorTradeDataPort } from './navigator/trade-data-port.js';
import { readLiveNavigatorSession, type NavigatorIdentitySessionPort } from './navigator/identity-session-port.js';
import { navigatorTierGate } from './navigator/tier-gate.js';
import { runNavigatorAnswerSession } from './navigator/session-run.js';
import { auditNavigatorDataTool, emptyNavigatorAuditLog } from './navigator/action-audit.js';
import { supportAgentGuardrail } from './support-agent/guardrail.js';
import { buildLeaderStats } from './copy-intel/stats.js';
import { presentLeaderDirectory, sortDirectoryByLeaderId } from './copy-intel/directory.js';
import { runCopyIntelStatsSession } from './copy-intel/session-run.js';
import { describeMerchantPolicy } from './merchant/policy.js';
import { describeNavigatorPolicy } from './navigator/policy.js';
import { describeCopyIntelPolicy } from './copy-intel/policy.js';
import { describeSupportPolicy } from './support-agent/policy.js';
import { watchApprovalFixtures } from './merchant/watch.js';
import { runMerchantWatchSession } from './merchant/session-run.js';
import type { PayMetricsPort } from './merchant/pay-metrics-port.js';
import type { SpotTickersPort } from './scanner/spot-tickers-port.js';
import type { CopyLeaderFixturesPort } from './copy-intel/live-leader-fixtures-port.js';
import { REFUSAL_CODES, serialiseGuardrail, toolRefusalCodes } from './fleet/guardrails.js';
import { draftTicketComment } from './support-agent/comment-draft.js';
import { supportGrounded } from './support-agent/grounded.js';
import { supportTierGate } from './support-agent/tier-gate.js';
import { invokeSupportDataTool, supportAnswerOrEscalate } from './support-agent/data-tools.js';
import type { SupportDeskPort } from './support-agent/desk-port.js';
import { runSupportReplySession } from './support-agent/session-run.js';
import { auditSupportDataTool, emptySupportAuditLog } from './support-agent/action-audit.js';
import { assessPreListingRisk } from './launch/pre-listing-assess.js';
import { draftScreeningSupport } from './risk-compliance/screening-draft.js';
import { refuseIdentityKycReviewWrite } from './risk-compliance/kyc-review-write.js';
import { envCoachGrounding, runCoachSession, type CoachGrounding } from './coach/grounded-session.js';
import { describeCoachPolicy } from './coach/policy.js';
import { envGrowthWarehouse, proposeGrowthCampaign } from './growth/campaign-proposal.js';
import { planRebalance } from './portfolio-agent/plan.js';
import { readOwnHoldings, type HoldingsLedger, type PortfolioPriceSource } from './portfolio-agent/holdings.js';
import { marketplaceInstallDoor } from './fleet/install.js';
import { listCatalogue } from './ops/catalogue.js';
import { listSessions } from './ops/ops-sessions.js';
import { engineForTasks, engineOfAdapter, routeIsMetered, type RouteDef, type RouteEngine } from './gateway/routing.js';
import { spendRouter } from './spend/routes.js';

/**
 * The internal tRPC surface (§1: "Fastify + tRPC (internal) / REST (public)").
 *
 * Two rules shape every procedure here.
 *
 * **Nothing leaves this service that a user may not see.** Outputs are declared
 * with `.output()` so the contract is validated on the way out, and the shapes
 * below carry routing task ids, model ALIASES and i18n keys — never a vendor
 * name, never an upstream error body, never a prompt (Doctrine §0.7, §10).
 *
 * **The log is the product.** `log.mine` and `session.log` return the same rows
 * an auditor would read, keyed for i18n, because §8.2's Agentic Law promises
 * the user a visible log and not a summary of one.
 *
 * A user always reads their own actions: every log query is scoped to
 * `ctx.principal.userId` rather than to a userId in the input. An agent audit
 * trail that one user can query for another is a privacy incident wearing a
 * feature's clothes.
 */

const actionOutput = z.object({
  id: z.string().guid(),
  sessionId: z.string().guid(),
  agentId: z.string(),
  sequence: z.number().int(),
  kind: z.enum(['session_open', 'session_close', 'completion', 'embedding', 'tool_call', 'usage_settlement']),
  status: z.enum(['executed', 'refused', 'failed']),
  tool: z.string().nullable(),
  /** The routing task. Configuration, not a product name. */
  task: z.string().nullable(),
  /** The routing alias. The concrete upstream id never leaves the adapter. */
  model: z.string().nullable(),
  /** Counts as strings: they are bigint in the database and JSON has no bigint. */
  inputTokens: z.string(),
  outputTokens: z.string(),
  cost: z.string(),
  refusalCode: z.string().nullable(),
  /** i18n key + params. The surface renders; this service never ships prose. */
  messageKey: z.string(),
  messageParams: z.record(z.string(), z.union([z.string(), z.number()])),
  occurredAt: z.string(),
});

/**
 * What a metered agent run cost, on the wire.
 *
 * Amounts are decimal STRINGS: they are scaled bigint in the meter and JSON has
 * no bigint, and a money field that arrives as a `number` has already lost the
 * argument (§0.5). Shared by every run that opens a session, so two agents can
 * never drift into reporting their bill in two different shapes.
 */
const runMeteringOutput = z.object({
  sessionId: z.string().nullable(),
  billedAmount: z.string(),
  assetId: z.string(),
  sessionClosed: z.boolean(),
  settlements: z.array(
    z.object({
      windowId: z.string(),
      amount: z.string(),
      chargeKey: z.string(),
      settled: z.boolean(),
    }),
  ),
});

/**
 * One grounded fact a navigator data tool returned.
 *
 * Every branch is an echo of what the tool was given or found. There is no
 * "assumed" or "estimated" member, and there is nowhere for one to hide: a
 * navigator answer is exactly the union of these, or it is a refusal.
 */
const navigatorFindingOutput = z.union([
  z.object({
    status: z.literal('ok'),
    tool: z.literal('trade.quote'),
    marketId: z.string(),
    last: z.string(),
    asOf: z.string(),
  }),
  z.object({
    status: z.literal('ok'),
    tool: z.literal('trade.markets.list'),
    markets: z.array(
      z.object({
        marketId: z.string(),
        symbol: z.string(),
        status: z.enum(['open', 'halted', 'closed']),
      }),
    ),
  }),
  z.object({
    status: z.literal('ok'),
    tool: z.literal('identity.session.read'),
    session: z.object({
      sessionId: z.string(),
      userId: z.string(),
      status: z.enum(['open', 'closed']),
    }),
  }),
]);

/** An ask that produced no fact, and who refused it. */
const navigatorUnansweredOutput = z.object({
  tool: z.string(),
  refusedBy: z.enum(['guardrail', 'tool']),
  reason: z.string(),
  userMessageKey: z.string(),
});

/**
 * One grounded fact a support desk tool returned.
 *
 * Same shape discipline as the navigator's: every branch echoes a row the caller
 * supplied or the desk held. The account projection carries status and KYC tier
 * and nothing else — there is no balance field here to leak or invent, which is
 * how §0.6 is kept by construction rather than by review.
 */
const supportFindingOutput = z.union([
  z.object({
    status: z.literal('ok'),
    tool: z.literal('support.kb.search'),
    articles: z.array(
      z.object({
        articleKey: z.string(),
        titleKey: z.string(),
        bodyKey: z.string(),
      }),
    ),
  }),
  z.object({
    status: z.literal('ok'),
    tool: z.literal('support.ticket.read'),
    ticket: z.object({
      ticketId: z.string(),
      ownerUserId: z.string(),
      status: z.enum(['open', 'pending', 'on_hold', 'resolved', 'closed']),
      category: z.string(),
    }),
  }),
  z.object({
    status: z.literal('ok'),
    tool: z.literal('identity.account.read'),
    account: z.object({
      userId: z.string(),
      status: z.enum(['active', 'frozen', 'closed']),
      kycTier: z.string(),
    }),
  }),
]);

/** A desk read that produced no fact, and who refused it. */
const supportUnansweredOutput = z.object({
  tool: z.string(),
  refusedBy: z.enum(['guardrail', 'tool']),
  reason: z.string(),
  userMessageKey: z.string(),
});

const sessionOutput = z.object({
  id: z.string().guid(),
  agentId: z.string(),
  guardrailVersion: z.number().int(),
  status: z.enum(['open', 'closed']),
  metered: z.boolean(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
});

function toActionOutput(action: AuditedAction) {
  return {
    id: action.id,
    sessionId: action.sessionId,
    agentId: action.agentId,
    sequence: action.sequence,
    kind: action.kind,
    status: action.status,
    tool: action.tool,
    task: action.task,
    model: action.model,
    inputTokens: action.inputTokens.toString(),
    outputTokens: action.outputTokens.toString(),
    cost: formatAmount(action.cost),
    refusalCode: action.refusalCode,
    messageKey: action.userMessageKey,
    messageParams: action.userMessageParams,
    occurredAt: action.occurredAt.toISOString(),
  };
}

/**
 * Map a domain error onto tRPC.
 *
 * The user-facing text is the COPY KEY, not `err.message`: the message is for
 * operators and is the one string in the system that could carry an upstream's
 * own words. `intafacedCode` lets a client branch on the machine code.
 */
function toTRPCError(err: unknown): TRPCError {
  // Already decided (an ownership check's NOT_FOUND): passed on, never reworded as an engine outage.
  if (err instanceof TRPCError) return err;
  if (err instanceof AgentError) {
    const code =
      err.code === 'agents.refused' || err.code === 'agents.spend_limit' || err.code === 'agents.spend_limit_unset'
        ? 'FORBIDDEN'
        : err.code === 'agents.session_not_found' ||
            err.code === 'agents.agent_not_found' ||
            err.code === 'agents.spend_reservation_not_found'
          ? 'NOT_FOUND'
          : err.code === 'agents.provider_unavailable'
            ? 'SERVICE_UNAVAILABLE'
            : 'BAD_REQUEST';

    return new TRPCError({ code, message: err.userMessageKey, cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'agents.error.engine_unavailable' });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTRPCError(err);
  }
}

export interface AgentsRouterDeps {
  readonly runtime: AgentRuntime;
  readonly gateway: ModelGateway;
  readonly meter: UsageMeter;
  readonly feeAssetId: string;
  /** AGENTS_METERING_ENABLED. Absent is treated as billed, so the customer keeps the cost confirmation. */
  readonly meteringEnabled?: boolean;
  /** Academy spine (or test inject). Absent → `envCoachGrounding()`. */
  readonly loadCoachGrounding?: () => Promise<CoachGrounding>;
  /** Live ops.support desk. Absent → support live tools refuse `no_live_kb`. */
  readonly supportDesk?: SupportDeskPort | null;
  /**
   * Live pay approval-rate samples. Unset in production (Class X) — live
   * merchant.runSession then refuses `no_live_metrics` rather than invent rates.
   */
  readonly payMetricsPort?: PayMetricsPort;
  /**
   * Live spot ticker samples. Unset in production (Class X) — live
   * scanner.runSession then refuses `no_live_tickers` rather than invent quotes.
   */
  readonly spotTickersPort?: SpotTickersPort;
  /**
   * Live trade.copy leader fixtures. Unset in production (Class X) — live
   * copyIntel.runSession then refuses `no_live_leaders` rather than invent PnL.
   */
  readonly copyLeaderFixturesPort?: CopyLeaderFixturesPort;
  /**
   * Trade base URL for navigator plane coercion. Unset → caller `live` becomes
   * effective `dark` (`trade_plane_dark`).
   */
  readonly navigatorTradeUrl?: string;
  /**
   * Live trade public REST for navigator data tools. Unset → live runs need
   * caller fixtures or refuse missing_fixture / empty_markets.
   */
  readonly navigatorTradeDataPort?: NavigatorTradeDataPort;
  /**
   * Live identity session projection for navigator identity.session.read. Unset
   * → live identity.session.read refuses `no_live_session` rather than using
   * caller fixtures as live truth.
   */
  readonly navigatorIdentitySessionPort?: NavigatorIdentitySessionPort;
  /** Agents schema. Absent on route stubs that never list sessions or the catalogue. */
  readonly sql?: Sql;
  /** Caller's balances. Read-only: the plan path calls `balances` and nothing else. */
  readonly portfolioLedger?: HoldingsLedger | null;
  /** Platform prices. Absent → portfolio.plan stays port_dark. Null price → portfolio.price_unset. */
  readonly portfolioPrices?: PortfolioPriceSource | null;
}

/**
 * Running an agent spends the person's money, so only the person runs one (OWNER 107): their own signed-in session,
 * never an API key (`agents:execute` is interactive-only in packages/auth), a sub-account or delegated token, or a
 * service forwarding their principal.
 */
function executeProcedure() {
  return scopedProcedure('agents:execute', { module: 'agents', person: true }).use(({ ctx, next }) => {
    if (ctx.principal.kid || ctx.principal.sub_account) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.execute_person_only' });
    }
    return next();
  });
}

/**
 * The person's own choice of which session their history shows: a write to their own state, so a key, a sub-account
 * or a service forwarding their principal does not make it, even with `agents:read`.
 */
function personReadProcedure() {
  return scopedProcedure('agents:read', { module: 'agents', person: true }).use(({ ctx, next }) => {
    if (ctx.principal.kid || ctx.principal.sub_account) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.select_person_only' });
    }
    return next();
  });
}

export function createAgentsRouter(deps: AgentsRouterDeps) {
  const {
    runtime,
    gateway,
    meter,
    feeAssetId,
    loadCoachGrounding,
    supportDesk,
    payMetricsPort,
    spotTickersPort,
    copyLeaderFixturesPort,
    navigatorTradeUrl,
    navigatorTradeDataPort,
    navigatorIdentitySessionPort,
    sql,
    portfolioLedger,
    portfolioPrices,
    meteringEnabled,
  } = deps;

  function routeEngine(route: RouteDef): { engine: RouteEngine; metered: boolean } {
    const provider = typeof gateway.registeredProvider === 'function' ? gateway.registeredProvider(route.providerId) : undefined;
    const engine = engineOfAdapter(provider);
    return { engine, metered: routeIsMetered(meteringEnabled, route.price) };
  }

  function agentEngine(tasks: readonly string[]): { engine: RouteEngine; metered: boolean } {
    return engineForTasks(
      tasks,
      (task) => {
        const route = gateway.routingTable.routes.find((row) => row.task === task);
        if (!route) return null;
        const flagged = routeEngine(route);
        return { engine: flagged.engine, billed: flagged.metered };
      },
      meteringEnabled,
    );
  }

  const resolveNavigatorPlane = (requested: 'live' | 'dark') => effectiveNavigatorTradePlane(requested, navigatorTradeUrl);

  /** A session belongs to exactly one user, and only that user may touch it. */
  async function ownedSession(sessionId: string, userId: string) {
    const session = await runtime.session(sessionId);
    // Same error for "does not exist" and "is not yours": distinguishing them
    // turns this endpoint into an oracle for other people's session ids.
    if (!session || session.userId !== userId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'agents.refused.session_closed' });
    }
    return session;
  }

  const settleWriteProcedure = publicProcedure.use(({ ctx, next }) => {
    requireSettleService(ctx.service);
    return next({ ctx });
  });

  return router({
    health: publicProcedure.output(z.object({ ok: z.literal(true), service: z.string() })).query(() => ({
      ok: true as const,
      service: 'svc-agents',
    })),

    /**
     * Operator session list (admin:read). Newest first. A customer session is refused.
     * Spend is sealed charged_amount per asset, or null with no_settled_window.
     */
    ops: router({
      sessions: scopedProcedure('admin:read', { module: 'agents' })
        .input(
          z.object({
            from: z.string().datetime().optional(),
            to: z.string().datetime().optional(),
            agentId: z.string().min(1).max(64).optional(),
            userId: z.string().min(1).max(64).optional(),
            status: z.enum(['open', 'closed']).optional(),
            limit: z.number().int().optional(),
            cursor: z.string().min(1).max(512).optional(),
          }),
        )
        .output(
          z.object({
            items: z.array(
              z.object({
                id: z.string().guid(),
                agentId: z.string(),
                userId: z.string(),
                status: z.enum(['open', 'closed']),
                openedAt: z.string(),
                closedAt: z.string().nullable(),
                actionCount: z.number().int(),
                spend: z.array(z.object({ assetId: z.string(), amount: z.string() })).nullable(),
                spendReason: z.enum(['no_settled_window']).nullable(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(({ input }) =>
          guard(async () => {
            if (!sql) throw new Error('agents sql is unset');
            const page = await listSessions(sql, {
              userId: input.userId ?? null,
              agentId: input.agentId ?? null,
              status: input.status ?? null,
              from: input.from ? new Date(input.from) : null,
              to: input.to ? new Date(input.to) : null,
              limit: assertOpsSessionsLimit(input.limit),
              cursor: input.cursor ?? null,
              feeAssetId,
            });
            return {
              items: page.items.map((row) => ({
                id: row.id,
                agentId: row.agentId,
                userId: row.userId,
                status: row.status,
                openedAt: row.openedAt,
                closedAt: row.closedAt,
                actionCount: row.actionCount,
                spend: row.spend ? row.spend.map((line) => ({ assetId: line.assetId, amount: line.amount })) : null,
                spendReason: row.spendReason,
              })),
              nextCursor: page.nextCursor,
            };
          }),
        ),
    }),

    /**
     * The tasks this deployment can serve, and their ceilings.
     *
     * Deliberately includes the price: §8.2 meters per user, and a metered
     * service that will not tell you its rate before you use it is a service
     * nobody should use.
     */
    routes: router({
      list: scopedProcedure('agents:read', { module: 'agents' })
        .output(
          z.array(
            z.object({
              task: z.string(),
              maxOutputTokens: z.number().int(),
              capability: z.enum(['complete', 'stream', 'embed']),
              /** Null when this deployment publishes no rate for the task: it refuses every run (agents.price_unset). */
              inputPerMillion: z.string().nullable(),
              outputPerMillion: z.string().nullable(),
              assetId: z.string(),
              engine: z.enum(['sandbox', 'live', 'unknown']),
              metered: z.boolean(),
            }),
          ),
        )
        .query(() =>
          gateway.routingTable.routes.map((route) => {
            const flagged = routeEngine(route);
            return {
              task: route.task,
              maxOutputTokens: route.maxOutputTokens,
              capability: route.capability,
              inputPerMillion: route.price ? formatAmount(route.price.inputPerMillion) : null,
              outputPerMillion: route.price ? formatAmount(route.price.outputPerMillion) : null,
              assetId: feeAssetId,
              engine: flagged.engine,
              metered: flagged.metered,
            };
          }),
        ),
    }),

    agent: router({
      /** What an agent may do, so a user can read the guardrail before granting a session. */
      get: scopedProcedure('agents:read', { module: 'agents' })
        .input(z.object({ agentId: z.string().min(1) }))
        .output(
          z
            .object({
              agentId: z.string(),
              version: z.number().int(),
              enabled: z.boolean(),
              tools: z.array(
                z.object({
                  name: z.string(),
                  module: z.string(),
                  mode: z.enum(['read', 'write']),
                  requiresApproval: z.boolean(),
                  maxCallsPerSession: z.number().int().nullable(),
                  /** Every refusal the runtime can return for this tool under this guardrail, in check order. */
                  refusals: z.array(z.enum(REFUSAL_CODES)),
                }),
              ),
              /** The permission mode the agent runs under; null when the guardrail names none, which refuses live writes. */
              capacityMode: z.string().nullable(),
              limits: z.object({
                maxActionsPerSession: z.number().int(),
                maxOutputTokensPerCall: z.number().int(),
                maxSpendPerSession: z.string().nullable(),
                allowedModules: z.array(z.string()),
                allowedTasks: z.array(z.string()),
              }),
              engine: z.enum(['sandbox', 'live', 'unknown']),
              metered: z.boolean(),
            })
            .nullable(),
        )
        .query(({ input }) =>
          guard(async () => {
            const definition = await runtime.agentDefinition(input.agentId);
            if (!definition) return null;

            const { guardrail, enabled } = definition;
            const flagged = agentEngine(guardrail.limits.allowedTasks);
            return {
              agentId: guardrail.agentId,
              version: guardrail.version,
              enabled,
              tools: guardrail.tools.map((t) => ({
                name: t.name,
                module: t.module,
                mode: t.mode,
                requiresApproval: t.requiresApproval,
                maxCallsPerSession: t.maxCallsPerSession ?? null,
                refusals: toolRefusalCodes(guardrail, t),
              })),
              capacityMode: guardrail.capacityMode ?? null,
              limits: {
                maxActionsPerSession: guardrail.limits.maxActionsPerSession,
                maxOutputTokensPerCall: guardrail.limits.maxOutputTokensPerCall,
                maxSpendPerSession: guardrail.limits.maxSpendPerSession === null ? null : formatAmount(guardrail.limits.maxSpendPerSession),
                allowedModules: [...guardrail.limits.allowedModules],
                allowedTasks: [...guardrail.limits.allowedTasks],
              },
              engine: flagged.engine,
              metered: flagged.metered,
            };
          }),
        ),

      /**
       * Stored catalogue. Purpose is the column, null when absent.
       * Disabled agents stay in the list with enabled false.
       */
      catalogue: scopedProcedure('agents:read', { module: 'agents' })
        .output(
          z.array(
            z.object({
              agentId: z.string(),
              name: z.string().nullable(),
              purpose: z.string().nullable(),
              enabled: z.boolean(),
              version: z.number().int(),
            }),
          ),
        )
        .query(() =>
          guard(async () => {
            if (!sql) throw new Error('agents sql is unset');
            return listCatalogue(sql);
          }),
        ),
    }),

    session: router({
      open: executeProcedure()
        .input(z.object({ agentId: z.string().min(1) }))
        .output(sessionOutput)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const session = await runtime.openSession({ userId: ctx.principal.userId, agentId: input.agentId });
            return {
              id: session.id,
              agentId: session.agentId,
              guardrailVersion: session.guardrailVersion,
              status: session.status,
              metered: session.metered,
              openedAt: session.openedAt.toISOString(),
              closedAt: session.closedAt?.toISOString() ?? null,
            };
          }),
        ),

      close: executeProcedure()
        .input(z.object({ sessionId: z.string().guid() }))
        .output(sessionOutput)
        .mutation(({ ctx, input }) =>
          guard(async () => {
            await ownedSession(input.sessionId, ctx.principal.userId);
            // Settle before closing: a session that ends with unbilled windows
            // leaves usage that only a sweep job would ever find.
            await runtime.settleSession(input.sessionId);
            const session = await runtime.closeSession(input.sessionId);
            return {
              id: session.id,
              agentId: session.agentId,
              guardrailVersion: session.guardrailVersion,
              status: session.status,
              metered: session.metered,
              openedAt: session.openedAt.toISOString(),
              closedAt: session.closedAt?.toISOString() ?? null,
            };
          }),
        ),

      /**
       * One of the caller's own sessions: its state and every usage window with what it was charged. Open windows have
       * no amount yet; a sealed window with no ledger transaction is unpaid and is retried on its charge key.
       */
      detail: scopedProcedure('agents:read', { module: 'agents' })
        .input(z.object({ sessionId: z.string().guid() }))
        .output(
          z.object({
            session: sessionOutput,
            assetId: z.string(),
            windows: z.array(
              z.object({
                windowId: z.string(),
                openedAt: z.string(),
                state: z.enum(['open', 'unpaid', 'settled']),
                amount: z.string().nullable(),
                chargeKey: z.string().nullable(),
              }),
            ),
            /**
             * Each run of the session by its request id, oldest first. The run's claim commits before the engine is
             * called, so a run the engine has not answered reads `running`; one whose usage is recorded reads `completed`.
             */
            runs: z.array(
              z.object({
                requestId: z.string(),
                startedAt: z.string(),
                state: z.enum(['running', 'completed']),
              }),
            ),
          }),
        )
        .query(({ ctx, input }) =>
          guard(async () => {
            const session = await ownedSession(input.sessionId, ctx.principal.userId);
            if (!sql) throw new Error('agents sql is unset');
            const rows = await sql<
              Array<{
                window_id: string;
                opened_at: Date;
                sealed_at: Date | null;
                charged_amount: string | null;
                charge_key: string | null;
                charge_tx_id: string | null;
              }>
            >`
              SELECT window_id, opened_at, sealed_at, charged_amount::text, charge_key, charge_tx_id
                FROM agents.usage_windows
               WHERE session_id = ${session.id}
               ORDER BY opened_at, window_id
            `;
            const runs = await sql<Array<{ request_id: string; claimed_at: Date; recorded: boolean }>>`
              SELECT c.request_id, c.claimed_at,
                     EXISTS (SELECT 1 FROM agents.usage_records u
                              WHERE u.session_id = c.session_id AND u.request_id = c.request_id) AS recorded
                FROM agents.think_claims c
               WHERE c.session_id = ${session.id}
               ORDER BY c.claimed_at, c.request_id
            `;
            return {
              session: {
                id: session.id,
                agentId: session.agentId,
                guardrailVersion: session.guardrailVersion,
                status: session.status,
                metered: session.metered,
                openedAt: session.openedAt.toISOString(),
                closedAt: session.closedAt?.toISOString() ?? null,
              },
              assetId: feeAssetId,
              windows: rows.map((row) => ({
                windowId: row.window_id,
                openedAt: row.opened_at.toISOString(),
                state: row.sealed_at === null ? ('open' as const) : row.charge_tx_id ? ('settled' as const) : ('unpaid' as const),
                amount: row.charged_amount === null ? null : formatAmount(parseAmount(row.charged_amount)),
                chargeKey: row.charge_key,
              })),
              runs: runs.map((run) => ({
                requestId: run.request_id,
                startedAt: run.claimed_at.toISOString(),
                state: run.recorded ? ('completed' as const) : ('running' as const),
              })),
            };
          }),
        ),

      /**
       * The session the caller last selected in their history, kept by the service so the choice survives a reload and
       * another device. Null when they have selected none.
       */
      selected: scopedProcedure('agents:read', { module: 'agents' })
        .output(z.object({ sessionId: z.string().guid(), agentId: z.string() }).nullable())
        .query(({ ctx }) =>
          guard(async () => {
            if (!sql) throw new Error('agents sql is unset');
            const [row] = await sql<Array<{ session_id: string; agent_id: string }>>`
              SELECT s.id AS session_id, s.agent_id
                FROM agents.selected_sessions sel
                JOIN agents.agent_sessions s ON s.id = sel.session_id AND s.user_id = sel.user_id
               WHERE sel.user_id = ${ctx.principal.userId}
            `;
            return row ? { sessionId: row.session_id, agentId: row.agent_id } : null;
          }),
        ),

      /** Selects one of the caller's own sessions for their history; someone else's session is not found. */
      select: personReadProcedure()
        .input(z.object({ sessionId: z.string().guid() }))
        .output(z.object({ sessionId: z.string().guid(), agentId: z.string() }))
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const session = await ownedSession(input.sessionId, ctx.principal.userId);
            if (!sql) throw new Error('agents sql is unset');
            await sql`
              INSERT INTO agents.selected_sessions (user_id, session_id)
              VALUES (${ctx.principal.userId}, ${session.id})
              ON CONFLICT (user_id) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = now()
            `;
            return { sessionId: session.id, agentId: session.agentId };
          }),
        ),

      log: scopedProcedure('agents:read', { module: 'agents' })
        .input(z.object({ sessionId: z.string().guid(), limit: z.number().int().min(1).max(500).optional() }))
        .output(z.array(actionOutput))
        .query(({ ctx, input }) =>
          guard(async () => {
            await ownedSession(input.sessionId, ctx.principal.userId);
            return (await runtime.sessionLog(input.sessionId, assertSessionLogPageLimit(input.limit))).map(toActionOutput);
          }),
        ),

      /**
       * The caller's own sessions, newest first. Replaces deriving them from
       * log.mine (capped at 500 action rows). Spend follows the sealed-window rule.
       */
      mine: scopedProcedure('agents:read', { module: 'agents' })
        .input(z.object({ limit: z.number().int().optional(), cursor: z.string().min(1).max(512).optional() }))
        .output(
          z.object({
            items: z.array(
              z.object({
                id: z.string().guid(),
                agentId: z.string(),
                status: z.enum(['open', 'closed']),
                openedAt: z.string(),
                closedAt: z.string().nullable(),
                actionCount: z.number().int(),
                spend: z.array(z.object({ assetId: z.string(), amount: z.string() })).nullable(),
                spendReason: z.enum(['no_settled_window']).nullable(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(({ ctx, input }) =>
          guard(async () => {
            if (!sql) throw new Error('agents sql is unset');
            const page = await listSessions(sql, {
              userId: ctx.principal.userId,
              limit: assertSessionMineLimit(input.limit),
              cursor: input.cursor ?? null,
              feeAssetId,
            });
            return {
              items: page.items.map((row) => ({
                id: row.id,
                agentId: row.agentId,
                status: row.status,
                openedAt: row.openedAt,
                closedAt: row.closedAt,
                actionCount: row.actionCount,
                spend: row.spend ? row.spend.map((line) => ({ assetId: line.assetId, amount: line.amount })) : null,
                spendReason: row.spendReason,
              })),
              nextCursor: page.nextCursor,
            };
          }),
        ),
    }),

    run: router({
      /**
       * One metered engine call.
       *
       * `requestId` is supplied by the CALLER and is the anti-double-bill
       * handle: a client that retries after a timeout reuses it, and the
       * usage is counted once no matter how many times the request arrives.
       */
      complete: executeProcedure()
        .input(
          z.object({
            sessionId: z.string().guid(),
            requestId: z.string().min(8).max(200),
            task: z.string().min(1),
            system: z.string().max(20_000).optional(),
            messages: z
              .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(200_000) }))
              .min(1)
              .max(200),
            maxOutputTokens: z.number().int().min(1).optional(),
          }),
        )
        .output(
          z.object({
            text: z.string(),
            inputTokens: z.number().int(),
            outputTokens: z.number().int(),
            cost: z.string(),
            assetId: z.string(),
            metered: z.boolean(),
            action: actionOutput,
          }),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            await ownedSession(input.sessionId, ctx.principal.userId);
            const result = await runtime.think({
              sessionId: input.sessionId,
              requestId: input.requestId,
              task: input.task,
              ...(input.system ? { system: input.system } : {}),
              messages: input.messages,
              ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
            });

            return {
              text: result.text,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              cost: formatAmount(result.cost),
              assetId: feeAssetId,
              metered: result.metered,
              action: toActionOutput(result.action),
            };
          }),
        ),
    }),

    usage: router({
      /** What the current window would cost if it settled now. Bills nothing. */
      current: scopedProcedure('agents:read', { module: 'agents' })
        .input(z.object({ sessionId: z.string().guid() }))
        .output(z.object({ windowId: z.string(), pending: z.string(), sessionTotal: z.string(), assetId: z.string() }))
        .query(({ ctx, input }) =>
          guard(async () => {
            await ownedSession(input.sessionId, ctx.principal.userId);
            const windowId = meter.windowFor();
            const [pending, sessionTotal] = await Promise.all([
              meter.pendingCost(input.sessionId, windowId),
              meter.sessionSpend(input.sessionId),
            ]);
            return {
              windowId,
              pending: formatAmount(pending),
              sessionTotal: formatAmount(sessionTotal),
              assetId: feeAssetId,
            };
          }),
        ),

      /**
       * Settle a window. House sweep, not the user's.
       *
       * HMAC as svc-agents. Session admin:write is not a service caller.
       * Unsigned 401. Wrong HMAC caller (svc-trade) 403.
       */
      settle: settleWriteProcedure
        .input(z.object({ sessionId: z.string().guid(), windowId: z.string().min(1) }))
        .output(z.object({ amount: z.string(), assetId: z.string(), chargeKey: z.string(), settled: z.boolean() }))
        .mutation(({ input }) =>
          guard(async () => {
            const result = await runtime.settleWindow(input.sessionId, input.windowId);
            return {
              amount: formatAmount(result.amount),
              assetId: feeAssetId,
              chargeKey: result.chargeKey,
              settled: result.settled,
            };
          }),
        ),

      /**
       * Settle every open (or sealed-unbilled) window on a session.
       *
       * Same money path as `session.close` / `runtime.settleSession` — one
       * `feeCharge` per window, ledger-keyed, idempotent. HMAC as svc-agents
       * so a user session cannot force a house sweep; `usage.settle` remains
       * for a single known window id.
       */
      settleSession: settleWriteProcedure
        .input(z.object({ sessionId: z.string().guid() }))
        .output(
          z.object({
            assetId: z.string(),
            settlements: z.array(
              z.object({
                windowId: z.string(),
                amount: z.string(),
                chargeKey: z.string(),
                settled: z.boolean(),
              }),
            ),
          }),
        )
        .mutation(({ input }) =>
          guard(async () => {
            const results = await runtime.settleSession(input.sessionId);
            return {
              assetId: feeAssetId,
              settlements: results.map((r) => ({
                windowId: r.windowId,
                amount: formatAmount(r.amount),
                chargeKey: r.chargeKey,
                settled: r.settled,
              })),
            };
          }),
        ),
    }),

    /** THE USER-VISIBLE LOG (§8.2). Always the caller's own. Blank limit refuses — never invent 100. */
    log: router({
      mine: scopedProcedure('agents:read', { module: 'agents' })
        .input(z.object({ limit: z.number().int().min(1).max(500).optional() }).optional())
        .output(z.array(actionOutput))
        .query(({ ctx, input }) =>
          guard(async () => (await runtime.userLog(ctx.principal.userId, assertUserLogPageLimit(input?.limit))).map(toActionOutput)),
        ),
    }),

    /**
     * Market Scanner — Stage-1 fixture rank + Stage-2 live data tools residual.
     *
     * Spec: docs/ops/trk/agents.scanner.md. Never invents prices or market rows:
     * caller hands allowlisted fixtures / tool rows. Dark plane + blank tier law
     * + unsealed D26-P0-11 signal-inputs law refuse-closed. No ledger, no order placement.
     */
    scanner: router({
      policy: publicProcedure.query(() => describeScannerPolicy()),

      rankFixtures: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            fixtures: z
              .array(
                z.object({
                  marketId: z.string().min(1).max(64),
                  last: z.string().nullable(),
                  volume24h: z.string().nullable(),
                  change24hBps: z.number().int().nullable(),
                  asOf: z.string().min(1),
                  maxAgeMs: z.number().int().positive().max(86_400_000),
                }),
              )
              .max(500),
            limit: z.number().int().min(1).max(100).optional(),
            marketPlane: z.enum(['live', 'dark']).optional(),
            marketAllowlist: z.array(z.string().min(1).max(64)).max(500).optional(),
            now: z.string().datetime().optional(),
            /** D26-P0-11. Omitted → production sealed v1 recipe. Explicit unpublished still refuses. */
            signalInputsLaw: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  p0_11: z.literal('sealed'),
                  allowedInputs: z.array(z.enum(['last', 'volume24h', 'change24hBps', 'spread', 'funding'])).max(20),
                  rankingRecipeId: z.literal('abs_change_x_log_volume'),
                }),
              ])
              .nullable()
              .optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              signals: z.array(
                z.object({
                  marketId: z.string(),
                  score: z.string(),
                  reasons: z.array(z.string()),
                }),
              ),
              rankedAt: z.string(),
              considered: z.number().int(),
              skippedStale: z.number().int(),
              skippedIncomplete: z.number().int(),
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.scanner.empty'),
            }),
            z.object({
              status: z.literal('unavailable'),
              userMessageKey: z.literal('agents.scanner.unavailable'),
              reason: z.enum(['stale', 'no_quotes', 'market_plane_dark']),
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum([
                'signal_inputs_law_blank',
                'inputs_empty',
                'ranking_recipe_unknown',
                'required_inputs_missing',
                'rank_limit_unset',
              ]),
              userMessageKey: z.enum([
                'agents.scanner.tier_closed',
                'agents.scanner.signal_inputs_closed',
                'agents.scanner.rank_limit_unset',
              ]),
              residual: z.literal(SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL).optional(),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = rankFixtures(input.fixtures, {
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.marketPlane === undefined ? {} : { marketPlane: input.marketPlane }),
            ...(input.marketAllowlist === undefined ? {} : { marketAllowlist: input.marketAllowlist }),
            ...(input.now === undefined ? {} : { now: new Date(input.now) }),
            signalInputsLaw: resolveScannerSignalInputsLaw(input.signalInputsLaw),
          });
          // Strip readonly for the wire shape (zod output is mutable arrays).
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              rankedAt: result.rankedAt,
              considered: result.considered,
              skippedStale: result.skippedStale,
              skippedIncomplete: result.skippedIncomplete,
              signals: result.signals.map((s) => ({
                marketId: s.marketId,
                score: s.score,
                reasons: [...s.reasons],
              })),
            };
          }
          return result;
        }),

      /**
       * Stage-2 declared read-only spot toolset. Money-write tools are not on
       * the list (refuse as undeclared / money_write before dispatch).
       */
      stage2Guardrail: scopedProcedure('agents:read', { module: 'agents' })
        .output(
          z.object({
            agentId: z.string(),
            version: z.number().int(),
            tools: z.array(
              z.object({
                name: z.string(),
                module: z.string(),
                mode: z.enum(['read', 'write']),
                requiresApproval: z.boolean(),
                maxCallsPerSession: z.number().int().optional(),
              }),
            ),
            limits: z.object({
              maxActionsPerSession: z.number().int(),
              maxOutputTokensPerCall: z.number().int(),
              maxSpendPerSession: z.string().nullable(),
              allowedModules: z.array(z.string()),
              allowedTasks: z.array(z.string()),
            }),
          }),
        )
        .query(() => serialiseGuardrail(scannerAgentGuardrail())),

      /**
       * Stage-2 tier gate — signal depth. Product-law matrix blank/unpublished
       * → refuse-closed. Does not invent free/staked depth.
       */
      tierGate: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            userTier: z.string().max(64),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z
                    .record(
                      z.string(),
                      z.object({
                        maxSignals: z.number().int().min(0).max(100),
                        tools: z.array(z.string().min(1).max(120)).max(100),
                      }),
                    )
                    .default({}),
                }),
              ])
              .nullable()
              .optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              userTier: z.string(),
              maxSignals: z.number().int(),
              allowedTools: z.array(z.string()),
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['tier_law_blank', 'tier_not_granted', 'depth_invalid']),
              userMessageKey: z.literal('agents.scanner.tier_closed'),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = scannerTierGate({ law: input.law ?? null, userTier: input.userTier });
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              userTier: result.userTier,
              maxSignals: result.maxSignals,
              allowedTools: [...result.allowedTools],
            };
          }
          return result;
        }),

      /**
       * Stage-2 real data tool invoke. Fixtures only — no invent quotes.
       * Tier law blank → refuse-closed. Max-age / incomplete → typed refuse.
       */
      invokeDataTool: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            tool: z.string().min(1).max(120),
            plane: z.enum(['live', 'dark']),
            userTier: z.string().max(64).optional(),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z
                    .record(
                      z.string(),
                      z.object({
                        maxSignals: z.number().int().min(0).max(100),
                        tools: z.array(z.string().min(1).max(120)).max(100),
                      }),
                    )
                    .default({}),
                }),
              ])
              .nullable()
              .optional(),
            now: z.string().datetime().optional(),
            ticker: z
              .object({
                marketId: z.string().min(1).max(64),
                last: z.string().nullable(),
                volume24h: z.string().nullable(),
                change24hBps: z.number().int().nullable(),
                asOf: z.string().min(1),
                maxAgeMs: z.number().int().positive().max(86_400_000),
              })
              .nullable()
              .optional(),
            markets: z
              .array(
                z.object({
                  marketId: z.string().min(1).max(64),
                  symbol: z.string().min(1).max(64),
                  status: z.enum(['open', 'halted', 'closed']),
                }),
              )
              .max(500)
              .nullable()
              .optional(),
            bookTop: z
              .object({
                marketId: z.string().min(1).max(64),
                bid: z.string().nullable(),
                ask: z.string().nullable(),
                asOf: z.string().min(1),
                maxAgeMs: z.number().int().positive().max(86_400_000),
              })
              .nullable()
              .optional(),
          }),
        )
        .output(
          z.union([
            z.object({
              status: z.literal('ok'),
              tool: z.literal('trade.ticker'),
              marketId: z.string(),
              last: z.string(),
              volume24h: z.string(),
              change24hBps: z.number().int(),
              asOf: z.string(),
            }),
            z.object({
              status: z.literal('ok'),
              tool: z.literal('trade.markets.list'),
              markets: z.array(
                z.object({
                  marketId: z.string(),
                  symbol: z.string(),
                  status: z.enum(['open', 'halted', 'closed']),
                }),
              ),
            }),
            z.object({
              status: z.literal('ok'),
              tool: z.literal('trade.book.top'),
              marketId: z.string(),
              bid: z.string(),
              ask: z.string(),
              asOf: z.string(),
            }),
            z.object({
              status: z.literal('refuse'),
              tool: z.string(),
              reason: z.enum([
                'market_plane_dark',
                'tier_law_blank',
                'tier_not_granted',
                'depth_invalid',
                'tool_not_declared',
                'money_write',
                'tool_not_in_tier',
                'missing_fixture',
                'incomplete_ticker',
                'incomplete_book',
                'invalid_decimal',
                'stale',
                'empty_markets',
              ]),
              userMessageKey: z.enum(['agents.scanner.unavailable', 'agents.scanner.tier_closed']),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = invokeScannerDataTool({
            tool: input.tool,
            plane: input.plane,
            tierLaw: input.law ?? null,
            userTier: input.userTier ?? '',
            ...(input.now === undefined ? {} : { now: new Date(input.now) }),
            ticker: input.ticker ?? null,
            markets: input.markets ?? null,
            bookTop: input.bookTop ?? null,
          });
          if (result.status === 'ok' && result.tool === 'trade.markets.list') {
            return {
              status: 'ok' as const,
              tool: 'trade.markets.list' as const,
              markets: result.markets.map((m) => ({
                marketId: m.marketId,
                symbol: m.symbol,
                status: m.status,
              })),
            };
          }
          return result;
        }),

      /**
       * Stage-2 rank via allowlisted ticker tools + tier depth.
       * Blank P0-11 / blank law / dark plane / all tickers refused → typed refuse (no invent).
       */
      rankLive: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            plane: z.enum(['live', 'dark']),
            userTier: z.string().max(64),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z
                    .record(
                      z.string(),
                      z.object({
                        maxSignals: z.number().int().min(0).max(100),
                        tools: z.array(z.string().min(1).max(120)).max(100),
                      }),
                    )
                    .default({}),
                }),
              ])
              .nullable()
              .optional(),
            signalInputsLaw: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  p0_11: z.literal('sealed'),
                  allowedInputs: z.array(z.enum(['last', 'volume24h', 'change24hBps', 'spread', 'funding'])).max(20),
                  rankingRecipeId: z.literal('abs_change_x_log_volume'),
                }),
              ])
              .nullable()
              .optional(),
            tickers: z
              .array(
                z.object({
                  marketId: z.string().min(1).max(64),
                  last: z.string().nullable(),
                  volume24h: z.string().nullable(),
                  change24hBps: z.number().int().nullable(),
                  asOf: z.string().min(1),
                  maxAgeMs: z.number().int().positive().max(86_400_000),
                }),
              )
              .max(500),
            marketAllowlist: z.array(z.string().min(1).max(64)).max(500).optional(),
            now: z.string().datetime().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              signals: z.array(
                z.object({
                  marketId: z.string(),
                  score: z.string(),
                  reasons: z.array(z.string()),
                }),
              ),
              rankedAt: z.string(),
              considered: z.number().int(),
              skippedStale: z.number().int(),
              skippedIncomplete: z.number().int(),
              maxSignals: z.number().int(),
              userTier: z.string(),
              tickersAccepted: z.number().int(),
              tickersRefused: z.number().int(),
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.scanner.empty'),
            }),
            z.object({
              status: z.literal('unavailable'),
              userMessageKey: z.literal('agents.scanner.unavailable'),
              reason: z.enum(['stale', 'no_quotes', 'market_plane_dark']),
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum([
                'tier_law_blank',
                'tier_not_granted',
                'depth_invalid',
                'market_plane_dark',
                'no_live_tickers',
                'signal_inputs_law_blank',
                'inputs_empty',
                'ranking_recipe_unknown',
                'required_inputs_missing',
                'rank_limit_unset',
              ]),
              userMessageKey: z.enum([
                'agents.scanner.unavailable',
                'agents.scanner.tier_closed',
                'agents.scanner.signal_inputs_closed',
                'agents.scanner.rank_limit_unset',
              ]),
              residual: z.literal(SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL).optional(),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = rankLiveFromTickers({
            plane: input.plane,
            tierLaw: input.law ?? null,
            userTier: input.userTier,
            tickers: input.tickers,
            signalInputsLaw: resolveScannerSignalInputsLaw(input.signalInputsLaw),
            ...(input.marketAllowlist === undefined ? {} : { marketAllowlist: input.marketAllowlist }),
            ...(input.now === undefined ? {} : { now: new Date(input.now) }),
          });
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              rankedAt: result.rankedAt,
              considered: result.considered,
              skippedStale: result.skippedStale,
              skippedIncomplete: result.skippedIncomplete,
              maxSignals: result.maxSignals,
              userTier: result.userTier,
              tickersAccepted: result.tickersAccepted,
              tickersRefused: result.tickersRefused,
              signals: result.signals.map((s) => ({
                marketId: s.marketId,
                score: s.score,
                reasons: [...s.reasons],
              })),
            };
          }
          return result;
        }),

      /**
       * Stage-2 `scanner.rank` as a METERED RUN on the fleet runtime.
       *
       * The routes above are pure: they answer "what would the scanner say"
       * without a session, so the declared guardrail is enforced by nothing at
       * call time and the usage is metered by nothing at all. This one runs the
       * same pure ranker through `openSession → act → settle → closeSession`,
       * so every ticker fetch is guardrail-checked and audited, and the run
       * settles through `UsageMeter` → ledger — the only accounting path.
       *
       * Live requires SpotTickersPort; request-body tickers are not live truth.
       * Live tickers fetch needs owner-published `tickersLimit` (`?limit=`).
       *
       * A mutation, not a query: it opens a session and writes audit rows.
       */
      runSession: executeProcedure()
        .input(
          z.object({
            plane: z.enum(['live', 'dark']),
            userTier: z.string().max(64),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z
                    .record(
                      z.string(),
                      z.object({
                        maxSignals: z.number().int().min(0).max(100),
                        tools: z.array(z.string().min(1).max(120)).max(100),
                      }),
                    )
                    .default({}),
                }),
              ])
              .nullable()
              .optional(),
            signalInputsLaw: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  p0_11: z.literal('sealed'),
                  allowedInputs: z.array(z.enum(['last', 'volume24h', 'change24hBps', 'spread', 'funding'])).max(20),
                  rankingRecipeId: z.literal('abs_change_x_log_volume'),
                }),
              ])
              .nullable()
              .optional(),
            // Capped well under the guardrail's per-session action budget: one
            // ticker is one audited tool call.
            tickers: z
              .array(
                z.object({
                  marketId: z.string().min(1).max(64),
                  last: z.string().nullable(),
                  volume24h: z.string().nullable(),
                  change24hBps: z.number().int().nullable(),
                  asOf: z.string().min(1),
                  maxAgeMs: z.number().int().positive().max(86_400_000),
                }),
              )
              .max(50),
            marketAllowlist: z.array(z.string().min(1).max(64)).max(500).optional(),
            now: z.string().datetime().optional(),
            /**
             * Live tickers page size (`GET /api/v1/tickers?limit=`). Optional so
             * omit reaches the named refuse instead of Zod "Required". Never
             * invent 500; owner may pass 500.
             */
            tickersLimit: z.number().int().positive().max(500).optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              signals: z.array(
                z.object({
                  marketId: z.string(),
                  score: z.string(),
                  reasons: z.array(z.string()),
                }),
              ),
              rankedAt: z.string(),
              considered: z.number().int(),
              skippedStale: z.number().int(),
              skippedIncomplete: z.number().int(),
              maxSignals: z.number().int(),
              userTier: z.string(),
              tickersAccepted: z.number().int(),
              tickersRefusedByTool: z.number().int(),
              tickersRefusedByGuardrail: z.number().int(),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.scanner.empty'),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('unavailable'),
              userMessageKey: z.literal('agents.scanner.unavailable'),
              reason: z.enum(['stale', 'no_quotes', 'market_plane_dark']),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum([
                'tier_law_blank',
                'tier_not_granted',
                'depth_invalid',
                'market_plane_dark',
                'no_live_tickers',
                'tickers_limit_unset',
                'signal_inputs_law_blank',
                'inputs_empty',
                'ranking_recipe_unknown',
                'required_inputs_missing',
                'rank_limit_unset',
              ]),
              userMessageKey: z.enum([
                'agents.scanner.unavailable',
                'agents.scanner.tier_closed',
                'agents.scanner.signal_inputs_closed',
                'agents.scanner.rank_limit_unset',
                'agents.scanner.tickers_limit_unset',
              ]),
              residual: z.literal(SCANNER_SIGNAL_INPUTS_LAW_RESIDUAL).optional(),
              tickersRefusedByTool: z.number().int(),
              tickersRefusedByGuardrail: z.number().int(),
              metering: runMeteringOutput,
            }),
          ]),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const result = await runScannerRankSession({
              runtime,
              userId: ctx.principal.userId,
              feeAssetId,
              plane: input.plane,
              tierLaw: input.law ?? null,
              signalInputsLaw: resolveScannerSignalInputsLaw(input.signalInputsLaw),
              userTier: input.userTier,
              tickers: input.tickers,
              ...(spotTickersPort === undefined ? {} : { spotTickersPort }),
              ...(input.tickersLimit === undefined ? {} : { tickersLimit: input.tickersLimit }),
              ...(input.marketAllowlist === undefined ? {} : { marketAllowlist: input.marketAllowlist }),
              ...(input.now === undefined ? {} : { now: new Date(input.now) }),
            });

            const metering = {
              sessionId: result.metering.sessionId,
              billedAmount: result.metering.billedAmount,
              assetId: result.metering.assetId,
              sessionClosed: result.metering.sessionClosed,
              settlements: result.metering.settlements.map((s) => ({
                windowId: s.windowId,
                amount: s.amount,
                chargeKey: s.chargeKey,
                settled: s.settled,
              })),
            };

            if (result.status === 'ok') {
              return {
                status: 'ok' as const,
                rankedAt: result.rankedAt,
                considered: result.considered,
                skippedStale: result.skippedStale,
                skippedIncomplete: result.skippedIncomplete,
                maxSignals: result.maxSignals,
                userTier: result.userTier,
                tickersAccepted: result.tickersAccepted,
                tickersRefusedByTool: result.tickersRefusedByTool,
                tickersRefusedByGuardrail: result.tickersRefusedByGuardrail,
                signals: result.signals.map((s) => ({
                  marketId: s.marketId,
                  score: s.score,
                  reasons: [...s.reasons],
                })),
                metering,
              };
            }

            if (result.status === 'refuse') {
              return {
                status: 'refuse' as const,
                reason: result.reason,
                userMessageKey: result.userMessageKey,
                ...(result.residual === undefined ? {} : { residual: result.residual }),
                tickersRefusedByTool: result.tickersRefusedByTool,
                tickersRefusedByGuardrail: result.tickersRefusedByGuardrail,
                metering,
              };
            }

            if (result.status === 'empty') {
              return { status: 'empty' as const, userMessageKey: result.userMessageKey, metering };
            }

            return {
              status: 'unavailable' as const,
              userMessageKey: result.userMessageKey,
              reason: result.reason,
              metering,
            };
          }),
        ),
    }),

    /**
     * Navigator Stage-2 grounded plane gate.
     *
     * Caller states whether the trade data plane is live or dark. Dark refuses
     * plan/tool_select grounding rather than inventing market context.
     * Spec: docs/ops/trk/agents.navigator.md Stage 2.
     */
    navigator: router({
      policy: publicProcedure
        .output(
          z.object({
            moneyWriteTools: z.array(z.string()),
            moneyDeny: z.object({
              tools: z.number().int(),
              hasLedgerPost: z.number().int(),
              hasTradeOrder: z.number().int(),
              hasBankTransfer: z.number().int(),
            }),
            moneyDenyStatusLine: z.string(),
            moneyDenyExport: z.string(),
            moneyDenyBilledAmount: z.literal('0'),
            darkPlaneRefuse: z.object({
              reason: z.literal('trade_plane_dark'),
              userMessageKey: z.literal('agents.navigator.unavailable'),
            }),
            liveAllowedTasks: z.tuple([z.literal('navigator.plan'), z.literal('navigator.tool_select')]),
          }),
        )
        .query(() => {
          const policy = describeNavigatorPolicy();
          return {
            moneyWriteTools: [...policy.moneyWriteTools],
            moneyDeny: { ...policy.moneyDeny },
            moneyDenyStatusLine: policy.moneyDenyStatusLine,
            moneyDenyExport: policy.moneyDenyExport,
            moneyDenyBilledAmount: policy.moneyDenyBilledAmount,
            darkPlaneRefuse: { ...policy.darkPlaneRefuse },
            liveAllowedTasks: [policy.liveAllowedTasks[0], policy.liveAllowedTasks[1]] as ['navigator.plan', 'navigator.tool_select'],
          };
        }),

      grounded: scopedProcedure('agents:read', { module: 'agents' })
        .input(z.object({ plane: z.enum(['live', 'dark']) }))
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              plane: z.literal('live'),
              allowedTasks: z.tuple([z.literal('navigator.plan'), z.literal('navigator.tool_select')]),
            }),
            z.object({
              status: z.literal('refuse'),
              plane: z.literal('dark'),
              reason: z.literal('trade_plane_dark'),
              userMessageKey: z.literal('agents.navigator.unavailable'),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = navigatorGrounded(resolveNavigatorPlane(input.plane));
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              plane: 'live' as const,
              allowedTasks: ['navigator.plan', 'navigator.tool_select'] as ['navigator.plan', 'navigator.tool_select'],
            };
          }
          return result;
        }),

      /**
       * Stage-1 declared toolset + ceilings. Money-write tools are not on the
       * list (refuse as undeclared before dispatch). Spec: agents.navigator Stage 1.
       */
      stage1Guardrail: scopedProcedure('agents:read', { module: 'agents' })
        .output(
          z.object({
            agentId: z.string(),
            version: z.number().int(),
            tools: z.array(
              z.object({
                name: z.string(),
                module: z.string(),
                mode: z.enum(['read', 'write']),
                requiresApproval: z.boolean(),
                maxCallsPerSession: z.number().int().optional(),
              }),
            ),
            limits: z.object({
              maxActionsPerSession: z.number().int(),
              maxOutputTokensPerCall: z.number().int(),
              maxSpendPerSession: z.string().nullable(),
              allowedModules: z.array(z.string()),
              allowedTasks: z.array(z.string()),
            }),
          }),
        )
        .query(() => serialiseGuardrail(navigatorAgentGuardrail())),

      /**
       * Stage-2 tool_select: intersect candidates with the product Stage-1
       * allowlist. Dark plane / empty candidates refuse; money-write and
       * off-list candidates refused. Caller-supplied `tools` cannot widen
       * the grant — that was a public-door hole.
       */
      selectTools: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            plane: z.enum(['live', 'dark']),
            candidates: z.array(z.string().min(1).max(120)).max(100),
            tools: z
              .array(
                z.object({
                  name: z.string().min(1).max(120),
                  module: z.string().min(1).max(64),
                  mode: z.enum(['read', 'write']),
                  requiresApproval: z.boolean().optional(),
                }),
              )
              .max(100),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              selected: z.array(z.string()),
              refused: z.array(
                z.object({
                  tool: z.string(),
                  reason: z.enum(['not_declared', 'money_write', 'write_mode']),
                }),
              ),
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['trade_plane_dark', 'no_candidates']),
              userMessageKey: z.literal('agents.navigator.unavailable').optional(),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = selectNavigatorTools({
            plane: resolveNavigatorPlane(input.plane),
            guardrail: navigatorAgentGuardrail(),
            candidates: input.candidates,
          });
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              selected: [...result.selected],
              refused: result.refused.map((r) => ({ tool: r.tool, reason: r.reason })),
            };
          }
          return result;
        }),

      /**
       * Stage-2 tier gate. Product-law matrix blank/unpublished → refuse-closed.
       * Does not invent free/staked/premium grants.
       */
      tierGate: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            userTier: z.string().max(64),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z.record(z.string(), z.array(z.string().min(1).max(120)).max(100)).default({}),
                }),
              ])
              .nullable()
              .optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              userTier: z.string(),
              allowedTools: z.array(z.string()),
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['tier_law_blank', 'tier_not_granted']),
              userMessageKey: z.literal('agents.navigator.tier_closed'),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = navigatorTierGate({ law: input.law ?? null, userTier: input.userTier });
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              userTier: result.userTier,
              allowedTools: [...result.allowedTools],
            };
          }
          return result;
        }),

      /**
       * Stage-2 real data tool invoke + user-affecting audit row.
       * Fixtures only — no invent quotes. Tier law blank → refuse-closed.
       */
      invokeDataTool: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            tool: z.string().min(1).max(120),
            plane: z.enum(['live', 'dark']),
            userTier: z.string().max(64).optional(),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z.record(z.string(), z.array(z.string().min(1).max(120)).max(100)).default({}),
                }),
              ])
              .nullable()
              .optional(),
            now: z.string().datetime().optional(),
            quote: z
              .object({
                marketId: z.string().min(1).max(64),
                last: z.string().nullable(),
                asOf: z.string().min(1),
                maxAgeMs: z.number().int().positive().max(86_400_000),
              })
              .nullable()
              .optional(),
            markets: z
              .array(
                z.object({
                  marketId: z.string().min(1).max(64),
                  symbol: z.string().min(1).max(64),
                  status: z.enum(['open', 'halted', 'closed']),
                }),
              )
              .max(500)
              .nullable()
              .optional(),
            session: z
              .object({
                sessionId: z.string().min(1).max(120),
                userId: z.string().min(1).max(120),
                status: z.enum(['open', 'closed']),
              })
              .nullable()
              .optional(),
            occurredAt: z.string().datetime().optional(),
            /**
             * Live markets page size (`GET /api/v1/markets?limit=`). Optional so
             * omit reaches the named refuse instead of Zod "Required". Never
             * invent 50; owner may pass 50.
             */
            marketsLimit: z.number().int().positive().max(500).optional(),
          }),
        )
        .output(
          z.object({
            result: z.union([
              z.object({
                status: z.literal('ok'),
                tool: z.literal('trade.quote'),
                marketId: z.string(),
                last: z.string(),
                asOf: z.string(),
              }),
              z.object({
                status: z.literal('ok'),
                tool: z.literal('trade.markets.list'),
                markets: z.array(
                  z.object({
                    marketId: z.string(),
                    symbol: z.string(),
                    status: z.enum(['open', 'halted', 'closed']),
                  }),
                ),
              }),
              z.object({
                status: z.literal('ok'),
                tool: z.literal('identity.session.read'),
                session: z.object({
                  sessionId: z.string(),
                  userId: z.string(),
                  status: z.enum(['open', 'closed']),
                }),
              }),
              z.object({
                status: z.literal('refuse'),
                tool: z.string(),
                reason: z.enum([
                  'trade_plane_dark',
                  'tier_law_blank',
                  'tier_not_granted',
                  'tool_not_declared',
                  'money_write',
                  'tool_not_in_tier',
                  'missing_fixture',
                  'incomplete_quote',
                  'invalid_decimal',
                  'stale',
                  'empty_markets',
                  'markets_limit_unset',
                  'incomplete_session',
                  'no_live_session',
                  'subject_mismatch',
                ]),
                userMessageKey: z.enum([
                  'agents.navigator.unavailable',
                  'agents.navigator.tier_closed',
                  'agents.navigator.markets_limit_unset',
                ]),
              }),
            ]),
            audit: z.object({
              sequence: z.number().int(),
              kind: z.literal('tool_call'),
              status: z.enum(['executed', 'refused']),
              tool: z.string(),
              reason: z.string().nullable(),
              userMessageKey: z.string(),
              occurredAt: z.string(),
            }),
          }),
        )
        .query(async ({ ctx, input }) => {
          const plane = resolveNavigatorPlane(input.plane);
          const tool = input.tool.trim();
          let quote = input.quote ?? null;
          let markets = input.markets ?? null;

          if (plane === 'live' && navigatorTradeDataPort) {
            if (tool === 'trade.markets.list' && (!markets || markets.length === 0)) {
              const liveMarkets = await readLiveNavigatorMarkets(navigatorTradeDataPort, input.marketsLimit);
              if (liveMarkets.ok) {
                markets = [...liveMarkets.markets];
              } else if (liveMarkets.reason === 'markets_limit_unset') {
                const result = {
                  status: 'refuse' as const,
                  tool,
                  reason: 'markets_limit_unset' as const,
                  userMessageKey: 'agents.navigator.markets_limit_unset' as const,
                };
                const occurredAt = input.occurredAt ?? new Date().toISOString();
                const log = auditNavigatorDataTool(emptyNavigatorAuditLog(), result, occurredAt);
                const audit = log.entries[0]!;
                return {
                  result,
                  audit: {
                    sequence: audit.sequence,
                    kind: 'tool_call' as const,
                    status: audit.status,
                    tool: audit.tool,
                    reason: audit.reason,
                    userMessageKey: audit.userMessageKey,
                    occurredAt: audit.occurredAt,
                  },
                };
              }
            }
            if (tool === 'trade.quote') {
              const marketId = quote?.marketId?.trim() ?? '';
              if (marketId && (!quote || quote.last === null)) {
                const liveQuote = await navigatorTradeDataPort.quote(marketId).catch(() => null);
                if (liveQuote) quote = liveQuote;
              }
            }
          }

          let session = input.session ?? null;
          if (plane === 'live' && tool === 'identity.session.read') {
            const liveSession = await readLiveNavigatorSession(
              navigatorIdentitySessionPort,
              session?.sessionId ?? '',
              ctx.principal.userId,
            );
            // Live miss never falls back to a caller fixture.
            session = liveSession.ok ? liveSession.session : null;
          }

          const result = invokeNavigatorDataTool({
            tool,
            plane,
            tierLaw: input.law ?? null,
            userTier: input.userTier ?? '',
            requesterUserId: ctx.principal.userId,
            ...(input.now === undefined ? {} : { now: new Date(input.now) }),
            quote,
            markets,
            session,
          });
          const occurredAt = input.occurredAt ?? new Date().toISOString();
          const log = auditNavigatorDataTool(emptyNavigatorAuditLog(), result, occurredAt);
          const audit = log.entries[0]!;
          if (result.status === 'ok' && result.tool === 'trade.markets.list') {
            return {
              result: {
                status: 'ok' as const,
                tool: 'trade.markets.list' as const,
                markets: result.markets.map((m) => ({
                  marketId: m.marketId,
                  symbol: m.symbol,
                  status: m.status,
                })),
              },
              audit: {
                sequence: audit.sequence,
                kind: 'tool_call' as const,
                status: audit.status,
                tool: audit.tool,
                reason: audit.reason,
                userMessageKey: audit.userMessageKey,
                occurredAt: audit.occurredAt,
              },
            };
          }
          return {
            result,
            audit: {
              sequence: audit.sequence,
              kind: 'tool_call' as const,
              status: audit.status,
              tool: audit.tool,
              reason: audit.reason,
              userMessageKey: audit.userMessageKey,
              occurredAt: audit.occurredAt,
            },
          };
        }),

      /**
       * Stage-2 `navigator.answer` as a METERED RUN on the fleet runtime.
       *
       * The navigator routes above are pure: they answer "what would the
       * navigator say" without a session, so the declared guardrail is enforced
       * by nothing at call time and the usage is metered by nothing at all.
       * This one drives the same pure tools through
       * `openSession → act → settle → closeSession`, so every lookup is
       * guardrail-checked and audited, and the run settles through `UsageMeter`
       * → ledger — the only accounting path.
       *
       * A mutation, not a query: it opens a session and writes audit rows.
       */
      runSession: executeProcedure()
        .input(
          z.object({
            plane: z.enum(['live', 'dark']),
            userTier: z.string().max(64),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z.record(z.string(), z.array(z.string().min(1).max(120)).max(100)).default({}),
                }),
              ])
              .nullable()
              .optional(),
            // Capped well under the guardrail's per-session action budget: one
            // ask is one audited tool call, refusals included.
            asks: z
              .array(
                z.object({
                  tool: z.string().min(1).max(120),
                  quote: z
                    .object({
                      marketId: z.string().min(1).max(64),
                      last: z.string().nullable(),
                      asOf: z.string().min(1),
                      maxAgeMs: z.number().int().positive().max(86_400_000),
                    })
                    .nullable()
                    .optional(),
                  markets: z
                    .array(
                      z.object({
                        marketId: z.string().min(1).max(64),
                        symbol: z.string().min(1).max(64),
                        status: z.enum(['open', 'halted', 'closed']),
                      }),
                    )
                    .max(500)
                    .nullable()
                    .optional(),
                  session: z
                    .object({
                      sessionId: z.string().min(1).max(120),
                      userId: z.string().min(1).max(120),
                      status: z.enum(['open', 'closed']),
                    })
                    .nullable()
                    .optional(),
                }),
              )
              .max(20),
            now: z.string().datetime().optional(),
            /**
             * Live markets page size (`GET /api/v1/markets?limit=`). Optional so
             * omit reaches the named refuse instead of Zod "Required". Never
             * invent 50; owner may pass 50.
             */
            marketsLimit: z.number().int().positive().max(500).optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              userTier: z.string(),
              findings: z.array(navigatorFindingOutput),
              unanswered: z.array(navigatorUnansweredOutput),
              asked: z.number().int(),
              answered: z.number().int(),
              complete: z.boolean(),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.navigator.empty'),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum([
                'trade_plane_dark',
                'tier_law_blank',
                'tier_not_granted',
                'tool_not_declared',
                'no_grounded_answer',
                'markets_limit_unset',
              ]),
              userMessageKey: z.enum([
                'agents.navigator.unavailable',
                'agents.navigator.tier_closed',
                'agents.navigator.markets_limit_unset',
              ]),
              unanswered: z.array(navigatorUnansweredOutput),
              metering: runMeteringOutput,
            }),
          ]),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const result = await runNavigatorAnswerSession({
              runtime,
              userId: ctx.principal.userId,
              feeAssetId,
              plane: resolveNavigatorPlane(input.plane),
              tierLaw: input.law ?? null,
              userTier: input.userTier,
              asks: input.asks.map((ask) => ({
                tool: ask.tool,
                quote: ask.quote ?? null,
                markets: ask.markets ?? null,
                session: ask.session ?? null,
              })),
              ...(navigatorTradeDataPort ? { tradeDataPort: navigatorTradeDataPort } : {}),
              ...(navigatorIdentitySessionPort ? { identitySessionPort: navigatorIdentitySessionPort } : {}),
              ...(input.marketsLimit === undefined ? {} : { marketsLimit: input.marketsLimit }),
              ...(input.now === undefined ? {} : { now: new Date(input.now) }),
            });

            const metering = {
              sessionId: result.metering.sessionId,
              billedAmount: result.metering.billedAmount,
              assetId: result.metering.assetId,
              sessionClosed: result.metering.sessionClosed,
              settlements: result.metering.settlements.map((s) => ({
                windowId: s.windowId,
                amount: s.amount,
                chargeKey: s.chargeKey,
                settled: s.settled,
              })),
            };

            if (result.status === 'empty') {
              return { status: 'empty' as const, userMessageKey: result.userMessageKey, metering };
            }

            const unanswered = result.unanswered.map((u) => ({
              tool: u.tool,
              refusedBy: u.refusedBy,
              reason: u.reason,
              userMessageKey: u.userMessageKey as string,
            }));

            if (result.status === 'refuse') {
              return {
                status: 'refuse' as const,
                reason: result.reason,
                userMessageKey: result.userMessageKey,
                unanswered,
                metering,
              };
            }

            return {
              status: 'ok' as const,
              userTier: result.userTier,
              findings: result.findings.map((f) =>
                f.tool === 'trade.markets.list'
                  ? { status: 'ok' as const, tool: 'trade.markets.list' as const, markets: f.markets.map((m) => ({ ...m })) }
                  : f,
              ),
              unanswered,
              asked: result.asked,
              answered: result.answered,
              complete: result.complete,
              metering,
            };
          }),
        ),
    }),

    /**
     * Support Stage-2 comment draft gate.
     *
     * Pure validation for ticket comments: missing ticket, empty/overlong body,
     * and money-invent language refuse. Does not post — caller still needs a
     * real ticket surface + guardrail. Spec: docs/ops/trk/ops.support.md.
     */
    support: router({
      policy: publicProcedure
        .output(
          z.object({
            agentAssist: z.literal('agents.support'),
            deskMountain: z.literal('ops.support'),
            deskStandalone: z.literal(true),
            deskProductComplete: z.literal(false),
            moneyTools: z.array(z.string()),
            moneyDeny: z.object({
              tools: z.number().int(),
              hasLedgerPost: z.number().int(),
              hasPayRefund: z.number().int(),
              hasTradeOrder: z.number().int(),
            }),
            moneyDenyStatusLine: z.string(),
            moneyDenyExport: z.string(),
            guardrail: z.object({
              agentId: z.string(),
              version: z.number().int(),
              declared: z.number().int(),
              moneyDenied: z.number().int(),
              approvalRequired: z.number().int(),
            }),
            guardrailStatusLine: z.string(),
            guardrailExport: z.string(),
            declaredTools: z.array(z.string()),
            dataTools: z.array(z.string()),
            darkPlaneRefuse: z.object({
              reason: z.literal('desk_plane_dark'),
              userMessageKey: z.literal('agents.support.unavailable'),
            }),
            liveAllowedTasks: z.tuple([z.literal('support.classify'), z.literal('support.reply')]),
            tierLawRefuse: z.object({
              reason: z.literal('tier_law_blank'),
              userMessageKey: z.literal('agents.support.tier_closed'),
            }),
            escalationUserMessageKey: z.literal('agents.support.escalated'),
            inventsBalances: z.literal(false),
            inventsRefunds: z.literal(false),
            escalationFirstClass: z.literal(true),
          }),
        )
        .query(() => {
          const policy = describeSupportPolicy();
          return {
            ...policy,
            moneyTools: [...policy.moneyTools],
            moneyDeny: { ...policy.moneyDeny },
            guardrail: { ...policy.guardrail },
            declaredTools: [...policy.declaredTools],
            dataTools: [...policy.dataTools],
            darkPlaneRefuse: { ...policy.darkPlaneRefuse },
            liveAllowedTasks: [policy.liveAllowedTasks[0], policy.liveAllowedTasks[1]] as ['support.classify', 'support.reply'],
            tierLawRefuse: { ...policy.tierLawRefuse },
          };
        }),

      draftComment: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            ticketId: z.string().max(120).nullable().optional(),
            body: z.string().max(5_000).nullable().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              ticketId: z.string(),
              body: z.string(),
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['missing_ticket', 'empty_body', 'body_too_long', 'money_invent_language']),
              userMessageKey: z.literal('agents.support.comment_refused'),
            }),
          ]),
        )
        .query(({ input }) => draftTicketComment({ ticketId: input.ticketId, body: input.body })),

      /**
       * Stage-2 desk plane gate: dark or empty-KB refuses invent answers.
       * Spec: docs/ops/trk/ops.support.md / agents.support.
       */
      grounded: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            plane: z.enum(['live', 'dark']),
            kbPlane: z.enum(['live', 'dark']).optional(),
            kbHitCount: z.number().int().min(0).max(10_000).optional(),
            requireKb: z.boolean().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              plane: z.literal('live'),
              allowedTasks: z.tuple([z.literal('support.classify'), z.literal('support.reply')]),
            }),
            z.object({
              status: z.literal('refuse'),
              plane: z.literal('dark'),
              reason: z.enum(['desk_plane_dark', 'kb_empty']),
              userMessageKey: z.literal('agents.support.unavailable'),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = supportGrounded({
            plane: input.plane,
            ...(input.kbPlane === undefined ? {} : { kbPlane: input.kbPlane }),
            ...(input.kbHitCount === undefined ? {} : { kbHitCount: input.kbHitCount }),
            ...(input.requireKb === undefined ? {} : { requireKb: input.requireKb }),
          });
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              plane: 'live' as const,
              allowedTasks: ['support.classify', 'support.reply'] as ['support.classify', 'support.reply'],
            };
          }
          return result;
        }),

      /**
       * Stage-1/2 declared toolset. Money tools never granted (undeclared refuse).
       * Spec: agents.support Stage 1.
       */
      stage1Guardrail: scopedProcedure('agents:read', { module: 'agents' })
        .output(
          z.object({
            agentId: z.string(),
            version: z.number().int(),
            tools: z.array(
              z.object({
                name: z.string(),
                module: z.string(),
                mode: z.enum(['read', 'write']),
                requiresApproval: z.boolean(),
                maxCallsPerSession: z.number().int().optional(),
              }),
            ),
            limits: z.object({
              maxActionsPerSession: z.number().int(),
              maxOutputTokensPerCall: z.number().int(),
              maxSpendPerSession: z.string().nullable(),
              allowedModules: z.array(z.string()),
              allowedTasks: z.array(z.string()),
            }),
          }),
        )
        .query(() => serialiseGuardrail(supportAgentGuardrail())),

      /**
       * Stage-2 tier gate. Product-law matrix blank/unpublished → refuse-closed.
       * Does not invent which plan may use the assist layer.
       */
      tierGate: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            userTier: z.string().max(64),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z.record(z.string(), z.array(z.string().min(1).max(120)).max(100)).default({}),
                }),
              ])
              .nullable()
              .optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              userTier: z.string(),
              allowedTools: z.array(z.string()),
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['tier_law_blank', 'tier_not_granted']),
              userMessageKey: z.literal('agents.support.tier_closed'),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = supportTierGate({ law: input.law ?? null, userTier: input.userTier });
          if (result.status === 'ok') {
            return { status: 'ok' as const, userTier: result.userTier, allowedTools: [...result.allowedTools] };
          }
          return result;
        }),

      /**
       * Stage-2 desk data tool invoke + user-affecting audit row.
       *
       * Fixtures only — no invent KB answers, tickets or account state. The
       * requester is `ctx.principal.userId`, never an input field: a ticket or
       * account belonging to somebody else refuses rather than reads.
       */
      invokeDataTool: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            tool: z.string().min(1).max(120),
            plane: z.enum(['live', 'dark']),
            userTier: z.string().max(64).optional(),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z.record(z.string(), z.array(z.string().min(1).max(120)).max(100)).default({}),
                }),
              ])
              .nullable()
              .optional(),
            articles: z
              .array(
                z.object({
                  articleKey: z.string().min(1).max(160),
                  titleKey: z.string().min(1).max(160),
                  bodyKey: z.string().min(1).max(160),
                }),
              )
              .max(200)
              .nullable()
              .optional(),
            ticket: z
              .object({
                ticketId: z.string().min(1).max(120),
                ownerUserId: z.string().max(120),
                status: z.enum(['open', 'pending', 'on_hold', 'resolved', 'closed']),
                category: z.string().max(64),
              })
              .nullable()
              .optional(),
            account: z
              .object({
                userId: z.string().max(120),
                status: z.enum(['active', 'frozen', 'closed']),
                kycTier: z.string().max(64),
              })
              .nullable()
              .optional(),
            occurredAt: z.string().datetime().optional(),
            kbPlane: z.enum(['live', 'dark']).optional(),
            /**
             * KB search page size. Optional so omit reaches the named refuse
             * (`agents.kb_search_limit_unset`) instead of Zod "Required".
             */
            limit: z.number().int().positive().max(500).optional(),
          }),
        )
        .output(
          z.object({
            result: z.union([
              z.object({
                status: z.literal('ok'),
                tool: z.literal('support.kb.search'),
                articles: z.array(
                  z.object({
                    articleKey: z.string(),
                    titleKey: z.string(),
                    bodyKey: z.string(),
                  }),
                ),
              }),
              z.object({
                status: z.literal('ok'),
                tool: z.literal('support.ticket.read'),
                ticket: z.object({
                  ticketId: z.string(),
                  ownerUserId: z.string(),
                  status: z.enum(['open', 'pending', 'on_hold', 'resolved', 'closed']),
                  category: z.string(),
                }),
              }),
              z.object({
                status: z.literal('ok'),
                tool: z.literal('identity.account.read'),
                account: z.object({
                  userId: z.string(),
                  status: z.enum(['active', 'frozen', 'closed']),
                  kycTier: z.string(),
                }),
              }),
              z.object({
                status: z.literal('refuse'),
                tool: z.string(),
                reason: z.enum([
                  'desk_plane_dark',
                  'no_live_kb',
                  'kb_empty',
                  'tier_law_blank',
                  'tier_not_granted',
                  'tool_not_declared',
                  'money_tool',
                  'tool_not_in_tier',
                  'missing_requester',
                  'missing_fixture',
                  'empty_results',
                  'incomplete_article',
                  'incomplete_ticket',
                  'incomplete_account',
                  'not_ticket_owner',
                  'account_owner_mismatch',
                  'balance_field_forbidden',
                  'account_plane_dark',
                  'account_not_attempted',
                  'kb_search_limit_unset',
                ]),
                userMessageKey: z.enum([
                  'agents.support.unavailable',
                  'agents.support.tier_closed',
                  'agents.refused.kb_search_limit_unset',
                ]),
              }),
            ]),
            audit: z.object({
              sequence: z.number().int(),
              kind: z.literal('tool_call'),
              status: z.enum(['executed', 'refused']),
              tool: z.string(),
              reason: z.string().nullable(),
              userMessageKey: z.string(),
              occurredAt: z.string(),
            }),
          }),
        )
        .query(async ({ ctx, input }) => {
          const deskHeaders = forwardedPrincipalHeaders(ctx);
          const result = await invokeSupportDataTool({
            tool: input.tool,
            plane: input.plane,
            ...(input.kbPlane === undefined ? {} : { kbPlane: input.kbPlane }),
            requesterUserId: ctx.principal.userId,
            tierLaw: input.law ?? null,
            userTier: input.userTier ?? '',
            desk: supportDesk ?? null,
            deskHeaders,
            articles: input.articles ?? null,
            kbSearchLimit: input.limit,
            ticket: input.ticket ?? null,
            account: input.account ?? null,
          });
          const occurredAt = input.occurredAt ?? new Date().toISOString();
          const audit = auditSupportDataTool(emptySupportAuditLog(), result, occurredAt).entries[0]!;
          return {
            result:
              result.status === 'ok' && result.tool === 'support.kb.search'
                ? {
                    status: 'ok' as const,
                    tool: 'support.kb.search' as const,
                    articles: result.articles.map((a) => ({
                      articleKey: a.articleKey,
                      titleKey: a.titleKey,
                      bodyKey: a.bodyKey,
                    })),
                  }
                : result,
            audit: {
              sequence: audit.sequence,
              kind: 'tool_call' as const,
              status: audit.status,
              tool: audit.tool,
              reason: audit.reason,
              userMessageKey: audit.userMessageKey,
              occurredAt: audit.occurredAt,
            },
          };
        }),

      /**
       * Stage-2 typed "I don't know" — the escalate path.
       *
       * A KB read that refused or came back empty, or a request to move money,
       * escalates to a human ticket. There is no branch here that answers anyway.
       */
      answerOrEscalate: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            tool: z.string().min(1).max(120),
            plane: z.enum(['live', 'dark']),
            userTier: z.string().max(64).optional(),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z.record(z.string(), z.array(z.string().min(1).max(120)).max(100)).default({}),
                }),
              ])
              .nullable()
              .optional(),
            articles: z
              .array(
                z.object({
                  articleKey: z.string().min(1).max(160),
                  titleKey: z.string().min(1).max(160),
                  bodyKey: z.string().min(1).max(160),
                }),
              )
              .max(200)
              .nullable()
              .optional(),
            moneyRequest: z.boolean().optional(),
            /** Omitted → dark. Fixture articles are not a live ops.support KB. */
            kbPlane: z.enum(['live', 'dark']).optional(),
            /**
             * KB search page size. Optional so omit reaches the named refuse
             * instead of Zod "Required". Never invent 100.
             */
            limit: z.number().int().positive().max(500).optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('answer'),
              citedArticleKeys: z.array(z.string()).min(1),
            }),
            z.object({
              status: z.literal('escalate'),
              reason: z.enum(['kb_no_hit', 'money_request', 'desk_refused']),
              userMessageKey: z.literal('agents.support.escalated'),
            }),
          ]),
        )
        .query(async ({ ctx, input }) => {
          const kbResult = await invokeSupportDataTool({
            tool: input.tool,
            plane: input.plane,
            kbPlane: input.kbPlane ?? 'dark',
            requesterUserId: ctx.principal.userId,
            tierLaw: input.law ?? null,
            userTier: input.userTier ?? '',
            desk: supportDesk ?? null,
            articles: input.articles ?? null,
            kbSearchLimit: input.limit,
          });
          const decision = supportAnswerOrEscalate({
            kbResult,
            ...(input.moneyRequest === undefined ? {} : { moneyRequest: input.moneyRequest }),
          });
          if (decision.status === 'answer') {
            return { status: 'answer' as const, citedArticleKeys: [...decision.citedArticleKeys] };
          }
          return decision;
        }),

      /**
       * Stage-2 `support.reply` as a METERED RUN on the fleet runtime.
       *
       * The support routes above are pure: they answer "what would the desk say"
       * without a session, so the declared toolset is enforced by nothing at call
       * time and the usage is metered by nothing at all. This one drives the same
       * pure tools through `openSession → act → settle → closeSession`, so every
       * desk read is guardrail-checked and audited, and the run settles through
       * `UsageMeter` → ledger — the only accounting path.
       *
       * The requester is `ctx.principal.userId`, never an input field: a support
       * run that could read another user's ticket or account projection would be
       * a PII incident wearing a feature's clothes.
       *
       * A mutation, not a query: it opens a session and writes audit rows.
       */
      runSession: executeProcedure()
        .input(
          z.object({
            plane: z.enum(['live', 'dark']),
            userTier: z.string().max(64),
            law: z
              .union([
                z.object({ published: z.literal(false) }),
                z.object({
                  published: z.literal(true),
                  matrix: z.record(z.string(), z.array(z.string().min(1).max(120)).max(100)).default({}),
                }),
              ])
              .nullable()
              .optional(),
            /** The user is asking for money to move. Escalates to a person, free. */
            moneyRequest: z.boolean().optional(),
            /**
             * Published ops.support KB spine (contract `SupportKbArticle`).
             * Used when an ask carries `kbQuery` — never invents articles.
             */
            kbCatalog: z
              .array(
                z.object({
                  id: z.string().min(1).max(200),
                  titleKey: z.string().min(1).max(200),
                  bodyKey: z.string().min(1).max(200),
                }),
              )
              .max(500)
              .nullable()
              .optional(),
            // Capped well under the guardrail's per-session action budget: one
            // read is one audited tool call, refusals included.
            asks: z
              .array(
                z.object({
                  tool: z.string().min(1).max(120),
                  articles: z
                    .array(
                      z.object({
                        articleKey: z.string().min(1).max(160),
                        titleKey: z.string().min(1).max(160),
                        bodyKey: z.string().min(1).max(160),
                      }),
                    )
                    .max(200)
                    .nullable()
                    .optional(),
                  /** Search fragment against `kbCatalog` when articles omitted. */
                  kbQuery: z.string().max(200).nullable().optional(),
                  /**
                   * KB search page size. Optional so omit reaches the named
                   * refuse instead of Zod "Required". Never invent 100.
                   */
                  limit: z.number().int().positive().max(500).optional(),
                  ticket: z
                    .object({
                      ticketId: z.string().min(1).max(120),
                      ownerUserId: z.string().max(120),
                      status: z.enum(['open', 'pending', 'on_hold', 'resolved', 'closed']),
                      category: z.string().max(64),
                    })
                    .nullable()
                    .optional(),
                  account: z
                    .object({
                      userId: z.string().max(120),
                      status: z.enum(['active', 'frozen', 'closed']),
                      kycTier: z.string().max(64),
                    })
                    .nullable()
                    .optional(),
                  /** Contract grounding — unread/plane-dark refuses invent. */
                  accountGrounding: z
                    .discriminatedUnion('status', [
                      z.object({
                        status: z.literal('read'),
                        state: z.object({
                          userId: z.string().guid(),
                          status: z.enum(['active', 'frozen', 'closed']),
                          kycTier: z.enum(['none', 'basic', 'full', 'institutional']),
                        }),
                        readAt: z.string().datetime(),
                      }),
                      z.object({
                        status: z.literal('unread'),
                        reason: z.enum(['plane_dark', 'not_attempted']),
                      }),
                    ])
                    .nullable()
                    .optional(),
                }),
              )
              .max(20),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              userTier: z.string(),
              findings: z.array(supportFindingOutput),
              unanswered: z.array(supportUnansweredOutput),
              citedArticleKeys: z.array(z.string()).min(1),
              asked: z.number().int(),
              answered: z.number().int(),
              complete: z.boolean(),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('escalate'),
              reason: z.enum(['kb_no_hit', 'money_request', 'desk_refused']),
              userMessageKey: z.literal('agents.support.escalated'),
              findings: z.array(supportFindingOutput),
              unanswered: z.array(supportUnansweredOutput),
              caseFile: z.object({
                reason: z.enum(['kb_no_hit', 'money_request', 'desk_refused']),
                moneyRequest: z.boolean(),
                findings: z.array(supportFindingOutput),
                unanswered: z.array(supportUnansweredOutput),
                ticketIds: z.array(z.string()),
                citedArticleKeys: z.array(z.string()),
                accounts: z.array(
                  z.object({
                    userId: z.string(),
                    status: z.enum(['active', 'frozen', 'closed']),
                    kycTier: z.string(),
                  }),
                ),
              }),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('stopped'),
              reason: z.literal('aborted'),
              // No new i18n key — FE fence. Caller keys off status+reason.
              userMessageKey: z.literal('agents.support.unavailable'),
              findings: z.array(supportFindingOutput),
              unanswered: z.array(supportUnansweredOutput),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum([
                'desk_plane_dark',
                'tier_law_blank',
                'tier_not_granted',
                'no_grounded_read',
                'account_state_missing',
                'kb_plane_ungrounded',
                'no_live_kb',
              ]),
              userMessageKey: z.enum(['agents.support.unavailable', 'agents.support.tier_closed']),
              unanswered: z.array(supportUnansweredOutput),
              metering: runMeteringOutput,
            }),
          ]),
        )
        .mutation(({ ctx, input, signal }) =>
          guard(async () => {
            const result = await runSupportReplySession({
              runtime,
              userId: ctx.principal.userId,
              feeAssetId,
              plane: input.plane,
              tierLaw: input.law ?? null,
              userTier: input.userTier,
              ...(input.moneyRequest === undefined ? {} : { moneyRequest: input.moneyRequest }),
              ...(signal === undefined ? {} : { signal }),
              kbCatalog: input.kbCatalog ?? null,
              desk: supportDesk ?? null,
              deskHeaders: forwardedPrincipalHeaders(ctx),
              asks: input.asks.map((ask) => ({
                tool: ask.tool,
                articles: ask.articles ?? null,
                kbQuery: ask.kbQuery ?? null,
                limit: ask.limit,
                ticket: ask.ticket ?? null,
                account: ask.account ?? null,
                accountGrounding: ask.accountGrounding ?? null,
              })),
            });

            const metering = {
              sessionId: result.metering.sessionId,
              billedAmount: result.metering.billedAmount,
              assetId: result.metering.assetId,
              sessionClosed: result.metering.sessionClosed,
              settlements: result.metering.settlements.map((s) => ({
                windowId: s.windowId,
                amount: s.amount,
                chargeKey: s.chargeKey,
                settled: s.settled,
              })),
            };

            if (result.status === 'empty') {
              // Empty asks are not a live KB plane — reuse refuse, do not advertise `empty`.
              return {
                status: 'refuse' as const,
                reason: 'kb_plane_ungrounded' as const,
                userMessageKey: 'agents.support.unavailable' as const,
                unanswered: [],
                metering,
              };
            }

            const unanswered = result.unanswered.map((u) => ({
              tool: u.tool,
              refusedBy: u.refusedBy,
              reason: u.reason,
              userMessageKey: u.userMessageKey as string,
            }));

            if (result.status === 'refuse') {
              return {
                status: 'refuse' as const,
                reason: result.reason,
                userMessageKey: result.userMessageKey,
                unanswered,
                metering,
              };
            }

            const findings = result.findings.map((f) =>
              f.tool === 'support.kb.search'
                ? { status: 'ok' as const, tool: 'support.kb.search' as const, articles: f.articles.map((a) => ({ ...a })) }
                : f,
            );

            if (result.status === 'stopped') {
              return {
                status: 'stopped' as const,
                reason: result.reason,
                userMessageKey: result.userMessageKey,
                findings,
                unanswered,
                metering,
              };
            }

            if (result.status === 'escalate') {
              const cf = result.caseFile;
              return {
                status: 'escalate' as const,
                reason: result.reason,
                userMessageKey: result.userMessageKey,
                findings,
                unanswered,
                caseFile: {
                  reason: cf.reason,
                  moneyRequest: cf.moneyRequest,
                  findings,
                  unanswered,
                  ticketIds: [...cf.ticketIds],
                  citedArticleKeys: [...cf.citedArticleKeys],
                  accounts: cf.accounts.map((a) => ({ ...a })),
                },
                metering,
              };
            }

            return {
              status: 'ok' as const,
              userTier: result.userTier,
              findings,
              unanswered,
              citedArticleKeys: [...result.citedArticleKeys],
              asked: result.asked,
              answered: result.answered,
              complete: result.complete,
              metering,
            };
          }),
        ),
    }),

    /**
     * Copy-Intel Stage-1 — audited leader stats from caller fixtures only.
     * trade.copy is on tip; live leader plane is residual — dark refuses invent.
     * SPEC-SOVEREIGN §4: ok output is a directory (leaderId order), never a
     * returns-ranked marketing board (D26-P1-A5).
     * Spec: docs/ops/trk/agents.copy-intel.md Stage 1.
     */
    copyIntel: router({
      policy: publicProcedure
        .output(
          z.object({
            moneyWriteTools: z.array(z.string()),
            moneyDeny: z.object({
              tools: z.number().int(),
              hasLedgerPost: z.number().int(),
              hasTradeOrder: z.number().int(),
              hasCopyFollow: z.number().int(),
            }),
            moneyDenyStatusLine: z.string(),
            moneyDenyExport: z.string(),
            returnsRankForbiddenKeys: z.array(z.string()),
            returnsRankSortKeys: z.array(z.string()),
            marketingBoardModes: z.array(z.string()),
            returnsRankedBoardRefuseReason: z.literal('returns_ranked_board_forbidden'),
            directorySortKey: z.literal('leaderId'),
            rankedByReturns: z.literal(false),
          }),
        )
        .query(() => describeCopyIntelPolicy()),

      buildStats: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            fixtures: z
              .array(
                z.object({
                  leaderId: z.string().min(1).max(64),
                  realisedPnl: z.string().nullable(),
                  closedTrades: z.number().int().nullable(),
                  winningTrades: z.number().int().nullable(),
                  windowStart: z.string().min(1),
                  windowEnd: z.string().min(1),
                  source: z.string().min(1).max(64),
                }),
              )
              .max(500),
            copyPlane: z.enum(['live', 'dark']).optional(),
            leaderAllowlist: z.array(z.string().min(1).max(64)).max(500).optional(),
            now: z.string().datetime().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              stats: z.array(
                z.object({
                  leaderId: z.string(),
                  realisedPnl: z.string(),
                  closedTrades: z.number().int(),
                  winRate: z.string(),
                  windowStart: z.string(),
                  windowEnd: z.string(),
                }),
              ),
              audit: z.array(
                z.object({
                  id: z.string(),
                  writtenAt: z.string(),
                  source: z.string(),
                  leaderId: z.string(),
                  stat: z.object({
                    leaderId: z.string(),
                    realisedPnl: z.string(),
                    closedTrades: z.number().int(),
                    winRate: z.string(),
                    windowStart: z.string(),
                    windowEnd: z.string(),
                  }),
                  provenance: z.object({
                    fixture: z.literal(true),
                    source: z.string(),
                    windowStart: z.string(),
                    windowEnd: z.string(),
                  }),
                }),
              ),
              skippedIncomplete: z.number().int(),
              presentation: z.object({
                kind: z.literal('directory'),
                rankedByReturns: z.literal(false),
                sortKey: z.literal('leaderId'),
              }),
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.copy_intel.empty'),
            }),
            z.object({
              status: z.literal('unavailable'),
              userMessageKey: z.literal('agents.copy_intel.unavailable'),
              reason: z.enum(['no_data', 'invalid_window', 'copy_plane_dark']),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = buildLeaderStats(input.fixtures, {
            ...(input.copyPlane === undefined ? {} : { copyPlane: input.copyPlane }),
            ...(input.leaderAllowlist === undefined ? {} : { leaderAllowlist: input.leaderAllowlist }),
            ...(input.now === undefined ? {} : { now: new Date(input.now) }),
          });
          if (result.status === 'ok') {
            // Directory presentation (D26-P1-A5 residual): leaderId order on the wire —
            // pure buildLeaderStats keeps fixture order; this door never echoes a PnL rank.
            const ordered = sortDirectoryByLeaderId(result.stats);
            const byLeader = new Map(result.audit.map((a) => [a.leaderId, a] as const));
            return {
              status: 'ok' as const,
              skippedIncomplete: result.skippedIncomplete,
              stats: ordered.map((s) => ({ ...s })),
              audit: ordered
                .map((s) => byLeader.get(s.leaderId))
                .filter((a): a is NonNullable<typeof a> => a !== undefined)
                .map((a) => ({
                  id: a.id,
                  writtenAt: a.writtenAt,
                  source: a.source,
                  leaderId: a.leaderId,
                  stat: { ...a.stat },
                  provenance: { ...a.provenance },
                })),
              presentation: {
                kind: 'directory' as const,
                rankedByReturns: false as const,
                sortKey: 'leaderId' as const,
              },
            };
          }
          return result;
        }),

      /**
       * Present audited stats as a searchable directory.
       * Returns-rank / marketing-board modes refuse (SPEC-SOVEREIGN §4).
       */
      presentDirectory: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            stats: z
              .array(
                z.object({
                  leaderId: z.string().min(1).max(64),
                  realisedPnl: z.string(),
                  closedTrades: z.number().int(),
                  winRate: z.string(),
                  windowStart: z.string().min(1),
                  windowEnd: z.string().min(1),
                }),
              )
              .max(500),
            mode: z.string().max(64).optional(),
            sortBy: z.string().max(64).optional(),
            leaderFilter: z.array(z.string().min(1).max(64)).max(500).optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              skippedFiltered: z.number().int(),
              presentation: z.object({
                kind: z.literal('directory'),
                rankedByReturns: z.literal(false),
                sortKey: z.literal('leaderId'),
                leaders: z.array(
                  z.object({
                    leaderId: z.string(),
                    realisedPnl: z.string(),
                    closedTrades: z.number().int(),
                    winRate: z.string(),
                    windowStart: z.string(),
                    windowEnd: z.string(),
                  }),
                ),
              }),
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.copy_intel.empty'),
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['returns_ranked_board', 'marketing_board']),
              userMessageKey: z.literal('agents.copy_intel.unavailable'),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = presentLeaderDirectory({
            stats: input.stats,
            ...(input.mode === undefined ? {} : { mode: input.mode }),
            ...(input.sortBy === undefined ? {} : { sortBy: input.sortBy }),
            ...(input.leaderFilter === undefined ? {} : { leaderFilter: input.leaderFilter }),
          });
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              skippedFiltered: result.skippedFiltered,
              presentation: {
                kind: 'directory' as const,
                rankedByReturns: false as const,
                sortKey: 'leaderId' as const,
                leaders: result.presentation.leaders.map((l) => ({ ...l })),
              },
            };
          }
          return result;
        }),

      /**
       * Stage-2 `copy_intel.stats` as a METERED RUN on the fleet runtime.
       *
       * Pure `buildStats` answers without a session. This mutation runs the
       * same builder through `openSession → act → settle → closeSession` so
       * every leader read is guardrail-checked and audited. Dark copy plane
       * refuses before any session opens (unbilled). Never invents fee share.
       * Ok presentation is always a directory — never returns-ranked.
       */
      runSession: executeProcedure()
        .input(
          z.object({
            plane: z.enum(['live', 'dark']),
            fixtures: z
              .array(
                z.object({
                  leaderId: z.string().min(1).max(64),
                  realisedPnl: z.string().nullable(),
                  closedTrades: z.number().int().nullable(),
                  winningTrades: z.number().int().nullable(),
                  windowStart: z.string().min(1),
                  windowEnd: z.string().min(1),
                  source: z.string().min(1).max(64),
                }),
              )
              .max(50),
            leaderAllowlist: z.array(z.string().min(1).max(64)).max(500).optional(),
            now: z.string().datetime().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              stats: z.array(
                z.object({
                  leaderId: z.string(),
                  realisedPnl: z.string(),
                  closedTrades: z.number().int(),
                  winRate: z.string(),
                  windowStart: z.string(),
                  windowEnd: z.string(),
                }),
              ),
              audit: z.array(
                z.object({
                  id: z.string(),
                  writtenAt: z.string(),
                  source: z.string(),
                  leaderId: z.string(),
                  stat: z.object({
                    leaderId: z.string(),
                    realisedPnl: z.string(),
                    closedTrades: z.number().int(),
                    winRate: z.string(),
                    windowStart: z.string(),
                    windowEnd: z.string(),
                  }),
                  provenance: z.object({
                    fixture: z.literal(true),
                    source: z.string(),
                    windowStart: z.string(),
                    windowEnd: z.string(),
                  }),
                }),
              ),
              skippedIncomplete: z.number().int(),
              fixturesAccepted: z.number().int(),
              fixturesRefusedByGuardrail: z.number().int(),
              writesRefusedByGuardrail: z.number().int(),
              presentation: z.object({
                kind: z.literal('directory'),
                rankedByReturns: z.literal(false),
                sortKey: z.literal('leaderId'),
              }),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.copy_intel.empty'),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('unavailable'),
              userMessageKey: z.literal('agents.copy_intel.unavailable'),
              reason: z.enum(['no_data', 'invalid_window', 'copy_plane_dark']),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['copy_plane_dark', 'no_live_leaders', 'writes_refused']),
              userMessageKey: z.literal('agents.copy_intel.unavailable'),
              fixturesRefusedByGuardrail: z.number().int(),
              writesRefusedByGuardrail: z.number().int(),
              metering: runMeteringOutput,
            }),
          ]),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const result = await runCopyIntelStatsSession({
              runtime,
              userId: ctx.principal.userId,
              feeAssetId,
              plane: input.plane,
              fixtures: input.fixtures,
              ...(copyLeaderFixturesPort === undefined ? {} : { copyLeaderFixturesPort }),
              ...(input.leaderAllowlist === undefined ? {} : { leaderAllowlist: input.leaderAllowlist }),
              ...(input.now === undefined ? {} : { now: new Date(input.now) }),
            });

            const metering = {
              sessionId: result.metering.sessionId,
              billedAmount: result.metering.billedAmount,
              assetId: result.metering.assetId,
              sessionClosed: result.metering.sessionClosed,
              settlements: result.metering.settlements.map((s) => ({
                windowId: s.windowId,
                amount: s.amount,
                chargeKey: s.chargeKey,
                settled: s.settled,
              })),
            };

            if (result.status === 'ok') {
              const ordered = sortDirectoryByLeaderId(result.stats);
              const byLeader = new Map(result.audit.map((a) => [a.leaderId, a] as const));
              return {
                status: 'ok' as const,
                skippedIncomplete: result.skippedIncomplete,
                fixturesAccepted: result.fixturesAccepted,
                fixturesRefusedByGuardrail: result.fixturesRefusedByGuardrail,
                writesRefusedByGuardrail: result.writesRefusedByGuardrail,
                stats: ordered.map((s) => ({ ...s })),
                audit: ordered
                  .map((s) => byLeader.get(s.leaderId))
                  .filter((a): a is NonNullable<typeof a> => a !== undefined)
                  .map((a) => ({
                    id: a.id,
                    writtenAt: a.writtenAt,
                    source: a.source,
                    leaderId: a.leaderId,
                    stat: { ...a.stat },
                    provenance: { ...a.provenance },
                  })),
                presentation: {
                  kind: 'directory' as const,
                  rankedByReturns: false as const,
                  sortKey: 'leaderId' as const,
                },
                metering,
              };
            }

            if (result.status === 'empty') {
              return { status: 'empty' as const, userMessageKey: result.userMessageKey, metering };
            }

            if (result.status === 'unavailable') {
              return {
                status: 'unavailable' as const,
                userMessageKey: result.userMessageKey,
                reason: result.reason,
                metering,
              };
            }

            return {
              status: 'refuse' as const,
              reason: result.reason,
              userMessageKey: result.userMessageKey,
              fixturesRefusedByGuardrail: result.fixturesRefusedByGuardrail,
              writesRefusedByGuardrail: result.writesRefusedByGuardrail,
              metering,
            };
          }),
        ),
    }),

    /**
     * Merchant Stage-1 — approval-rate watch from caller fixtures only.
     * pay.routing / live metrics residual — dark pay plane refuses invent.
     * Money tools denied (guardrail). Spec: docs/ops/trk/agents.merchant.md Stage 1.
     */
    merchant: router({
      policy: publicProcedure
        .output(
          z.object({
            moneyWriteTools: z.array(z.string()),
            moneyDeny: z.object({
              tools: z.number().int(),
              hasLedgerPost: z.number().int(),
              hasPayRouteChange: z.number().int(),
            }),
            moneyDenyStatusLine: z.string(),
            moneyDenyExport: z.string(),
            watchRefuseReasons: z.array(z.string()),
            watchRefuse: z.object({
              codes: z.number().int(),
              hasNoMetrics: z.number().int(),
              hasPayPlaneDark: z.number().int(),
              hasStale: z.number().int(),
            }),
            liveMetricsRefuseReason: z.literal('no_live_metrics'),
            darkPayPlaneRefuseReason: z.literal('pay_plane_dark'),
            inventsApprovalRate: z.literal(false),
            allowedTask: z.literal('merchant.watch'),
          }),
        )
        .query(() => describeMerchantPolicy()),

      watch: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            points: z
              .array(
                z.object({
                  railId: z.string().min(1).max(64),
                  approvalRate: z.string().nullable(),
                  attempts: z.number().int().nullable(),
                  asOf: z.string().min(1),
                  maxAgeMs: z.number().int().positive(),
                }),
              )
              .max(500),
            threshold: z.string().optional(),
            payPlane: z.enum(['live', 'dark']).optional(),
            railAllowlist: z.array(z.string().min(1).max(64)).max(500).optional(),
            /** Sample floor — default 1 (zero attempts never alerts). */
            minAttempts: z.number().int().min(1).max(1_000_000).optional(),
            now: z.string().datetime().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              watchedAt: z.string(),
              considered: z.number().int(),
              skippedStale: z.number().int(),
              skippedIncomplete: z.number().int(),
              skippedLowSample: z.number().int(),
              alerts: z.array(
                z.object({
                  railId: z.string(),
                  approvalRate: z.string(),
                  attempts: z.number().int(),
                  threshold: z.string(),
                  kind: z.literal('below_threshold'),
                }),
              ),
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.merchant.empty'),
            }),
            z.object({
              status: z.literal('unavailable'),
              userMessageKey: z.literal('agents.merchant.unavailable'),
              reason: z.enum(['stale', 'no_metrics', 'pay_plane_dark']),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = watchApprovalFixtures(input.points, {
            ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
            ...(input.payPlane === undefined ? {} : { payPlane: input.payPlane }),
            ...(input.railAllowlist === undefined ? {} : { railAllowlist: input.railAllowlist }),
            ...(input.minAttempts === undefined ? {} : { minAttempts: input.minAttempts }),
            ...(input.now === undefined ? {} : { now: new Date(input.now) }),
          });
          if (result.status === 'ok') {
            return {
              status: 'ok' as const,
              watchedAt: result.watchedAt,
              considered: result.considered,
              skippedStale: result.skippedStale,
              skippedIncomplete: result.skippedIncomplete,
              skippedLowSample: result.skippedLowSample,
              alerts: result.alerts.map((a) => ({ ...a })),
            };
          }
          return result;
        }),

      /**
       * Stage-2 `merchant.watch` as a METERED RUN on the fleet runtime.
       *
       * The pure `watch` query above answers "what would the merchant say"
       * without a session. This mutation runs the same watcher through
       * `openSession → act → settle → closeSession`, so every metrics read is
       * guardrail-checked and audited, and the run settles through the meter.
       * Dark pay plane refuses before any session opens (unbilled).
       * Live requires PayMetricsPort; request-body points are not live truth.
       */
      runSession: executeProcedure()
        .input(
          z.object({
            plane: z.enum(['live', 'dark']),
            points: z
              .array(
                z.object({
                  railId: z.string().min(1).max(64),
                  approvalRate: z.string().nullable(),
                  attempts: z.number().int().nullable(),
                  asOf: z.string().min(1),
                  maxAgeMs: z.number().int().positive().max(86_400_000),
                }),
              )
              .max(50),
            threshold: z.string().optional(),
            railAllowlist: z.array(z.string().min(1).max(64)).max(500).optional(),
            minAttempts: z.number().int().min(1).max(1_000_000).optional(),
            now: z.string().datetime().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('ok'),
              watchedAt: z.string(),
              considered: z.number().int(),
              skippedStale: z.number().int(),
              skippedIncomplete: z.number().int(),
              skippedLowSample: z.number().int(),
              alerts: z.array(
                z.object({
                  railId: z.string(),
                  approvalRate: z.string(),
                  attempts: z.number().int(),
                  threshold: z.string(),
                  kind: z.literal('below_threshold'),
                }),
              ),
              pointsAccepted: z.number().int(),
              pointsRefusedByGuardrail: z.number().int(),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('empty'),
              userMessageKey: z.literal('agents.merchant.empty'),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('unavailable'),
              userMessageKey: z.literal('agents.merchant.unavailable'),
              reason: z.enum(['stale', 'no_metrics', 'pay_plane_dark']),
              metering: runMeteringOutput,
            }),
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['pay_plane_dark', 'no_live_metrics']),
              userMessageKey: z.literal('agents.merchant.unavailable'),
              pointsRefusedByGuardrail: z.number().int(),
              metering: runMeteringOutput,
            }),
          ]),
        )
        .mutation(({ ctx, input }) =>
          guard(async () => {
            const result = await runMerchantWatchSession({
              runtime,
              userId: ctx.principal.userId,
              feeAssetId,
              plane: input.plane,
              points: input.points,
              ...(payMetricsPort === undefined ? {} : { payMetricsPort }),
              ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
              ...(input.railAllowlist === undefined ? {} : { railAllowlist: input.railAllowlist }),
              ...(input.minAttempts === undefined ? {} : { minAttempts: input.minAttempts }),
              ...(input.now === undefined ? {} : { now: new Date(input.now) }),
            });

            const metering = {
              sessionId: result.metering.sessionId,
              billedAmount: result.metering.billedAmount,
              assetId: result.metering.assetId,
              sessionClosed: result.metering.sessionClosed,
              settlements: result.metering.settlements.map((s) => ({
                windowId: s.windowId,
                amount: s.amount,
                chargeKey: s.chargeKey,
                settled: s.settled,
              })),
            };

            if (result.status === 'ok') {
              return {
                status: 'ok' as const,
                watchedAt: result.watchedAt,
                considered: result.considered,
                skippedStale: result.skippedStale,
                skippedIncomplete: result.skippedIncomplete,
                skippedLowSample: result.skippedLowSample,
                alerts: result.alerts.map((a) => ({ ...a })),
                pointsAccepted: result.pointsAccepted,
                pointsRefusedByGuardrail: result.pointsRefusedByGuardrail,
                metering,
              };
            }

            if (result.status === 'empty') {
              return { status: 'empty' as const, userMessageKey: result.userMessageKey, metering };
            }

            if (result.status === 'unavailable') {
              return {
                status: 'unavailable' as const,
                userMessageKey: result.userMessageKey,
                reason: result.reason,
                metering,
              };
            }

            return {
              status: 'refuse' as const,
              reason: result.reason,
              userMessageKey: result.userMessageKey,
              pointsRefusedByGuardrail: result.pointsRefusedByGuardrail,
              metering,
            };
          }),
        ),
    }),

    /**
     * Launch Agent — pre-listing pattern flags (§8.2, §35).
     * Empty deployer history is refused — never a clean badge. Live chain
     * reputation port is Class X; production door fail-closes unread.
     */
    launch: router({
      assess: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            deployer: z.string().min(1).max(128).optional(),
            asBadge: z.boolean().optional(),
            asBlockDecision: z.boolean().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['deployer_missing', 'reputation_unread', 'history_absent', 'badge_forbidden', 'block_decision_forbidden']),
              kind: z.literal('not_a_badge'),
              isBadge: z.literal(false),
              isBlockDecision: z.literal(false),
              inventedCleanBadge: z.literal(false),
              userMessageKey: z.literal('agents.error.capability_unavailable'),
            }),
            z.object({
              status: z.literal('annotation'),
              kind: z.literal('pattern_flags'),
              isBadge: z.literal(false),
              isBlockDecision: z.literal(false),
              deployer: z.string(),
              lpLocks: z.number().int(),
              vestings: z.number().int(),
              patternFlags: z.array(
                z.object({
                  code: z.enum(['no_lp_locks', 'no_vestings', 'sparse_lp_locks', 'sparse_vestings']),
                  source: z.literal('deployer_reputation'),
                }),
              ),
              inventedCleanBadge: z.literal(false),
              userMessageKey: z.literal('agents.error.capability_unavailable'),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = assessPreListingRisk({
            ...(input.deployer === undefined ? {} : { deployer: input.deployer }),
            ...(input.asBadge === undefined ? {} : { asBadge: input.asBadge }),
            ...(input.asBlockDecision === undefined ? {} : { asBlockDecision: input.asBlockDecision }),
          });
          if (result.status === 'refuse') {
            return {
              status: 'refuse' as const,
              reason: result.reason,
              kind: 'not_a_badge' as const,
              isBadge: false as const,
              isBlockDecision: false as const,
              inventedCleanBadge: false as const,
              userMessageKey: 'agents.error.capability_unavailable' as const,
            };
          }
          return {
            status: 'annotation' as const,
            kind: 'pattern_flags' as const,
            isBadge: false as const,
            isBlockDecision: false as const,
            deployer: result.deployer,
            lpLocks: result.lpLocks,
            vestings: result.vestings,
            patternFlags: result.patternFlags.map((flag) => ({ ...flag })),
            inventedCleanBadge: false as const,
            userMessageKey: 'agents.error.capability_unavailable' as const,
          };
        }),
    }),

    /**
     * Risk & Compliance — screening-support drafts (§8.2).
     * Public door refuses when the sanctions list is empty / unset or inputs
     * are missing. Drafts are proposals only. Never writes identity.kyc-review
     * `reviewed_by`. Never invents JURISDICTION_MATRIX `blocked: true`.
     */
    riskCompliance: router({
      draftScreening: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            subjectId: z.string().min(1).max(64).optional(),
            region: z.string().min(1).max(8).optional(),
            asDecision: z.boolean().optional(),
            writeReviewedBy: z.boolean().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['screening_unset', 'screening_empty', 'inputs_missing', 'decision_forbidden']),
              kind: z.literal('not_a_decision'),
              isDecision: z.literal(false),
              userMessageKey: z.literal('agents.error.capability_unavailable'),
              screeningDeclaration: z.enum(['unset', 'listed', 'reviewed-empty']),
              screeningConfigured: z.boolean(),
              screeningSource: z.string(),
              inventedBlockedList: z.literal(false),
            }),
            z.object({
              status: z.literal('draft'),
              kind: z.literal('proposal'),
              isDecision: z.literal(false),
              subjectId: z.string(),
              region: z.string(),
              screeningDeclaration: z.enum(['unset', 'listed', 'reviewed-empty']),
              screeningConfigured: z.boolean(),
              screeningSource: z.string(),
              listHitCount: z.number().int(),
              businessHitCount: z.number().int(),
              listHits: z.array(
                z.object({
                  region: z.string(),
                  reason: z.string(),
                  source: z.string(),
                  authority: z.literal('screening'),
                }),
              ),
              inventedBlockedList: z.literal(false),
            }),
          ]),
        )
        .query(({ input }) => {
          const result = draftScreeningSupport({
            screening: envScreeningList(),
            businessBlocks: SHIPPED_BUSINESS_BLOCKS,
            ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
            ...(input.region === undefined ? {} : { region: input.region }),
            ...(input.asDecision === undefined ? {} : { asDecision: input.asDecision }),
            ...(input.writeReviewedBy === undefined ? {} : { writeReviewedBy: input.writeReviewedBy }),
          });
          if (result.status === 'refuse') {
            return {
              status: 'refuse' as const,
              reason: result.reason,
              kind: 'not_a_decision' as const,
              isDecision: false as const,
              userMessageKey: 'agents.error.capability_unavailable' as const,
              screeningDeclaration: result.screeningDeclaration,
              screeningConfigured: result.screeningConfigured,
              screeningSource: result.screeningSource,
              inventedBlockedList: false as const,
            };
          }
          return {
            status: 'draft' as const,
            kind: 'proposal' as const,
            isDecision: false as const,
            subjectId: result.subjectId,
            region: result.region,
            screeningDeclaration: result.screeningDeclaration,
            screeningConfigured: result.screeningConfigured,
            screeningSource: result.screeningSource,
            listHitCount: result.listHitCount,
            businessHitCount: result.businessHitCount,
            listHits: result.listHits.map((hit) => ({
              region: hit.region,
              reason: hit.reason,
              source: hit.source,
              authority: 'screening' as const,
            })),
            inventedBlockedList: false as const,
          };
        }),

      refuseKycReview: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            recordId: z.string().min(1).max(64).optional(),
            reviewerId: z.string().min(1).max(64).optional(),
            decision: z.string().max(32).optional(),
          }),
        )
        .output(
          z.object({
            status: z.literal('refuse'),
            reason: z.literal('kyc_review_is_operator_only'),
            kind: z.literal('not_a_decision'),
            isDecision: z.literal(false),
            column: z.literal('reviewed_by'),
            writable: z.literal(false),
            userMessageKey: z.literal('agents.error.capability_unavailable'),
          }),
        )
        .query(({ input }) => refuseIdentityKycReviewWrite(input)),
    }),

    /**
     * AI Coach — curriculum-grounded citations (§8.2). Empty catalog is a
     * chatbot (refuse). Licensed library titles are never invented. Position
     * grounding is owner-undecided → refuse. Not a fleet runSession.
     */
    coach: router({
      policy: publicProcedure.query(() => describeCoachPolicy()),

      session: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            ask: z.string().max(2000).optional(),
            requestedSlug: z.string().min(1).max(128).optional(),
            includePositions: z.boolean().optional(),
            asAdvice: z.boolean().optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('refuse'),
              reason: z.enum([
                'curriculum_empty',
                'library_import_pending',
                'invented_library',
                'positions_not_decided',
                'advice_forbidden',
              ]),
              kind: z.literal('not_advice'),
              isAdvice: z.literal(false),
              positionsReferenced: z.literal(false),
              licensedLibraryImported: z.boolean(),
              inventedLibrary: z.literal(false),
              citedCount: z.literal(0),
              userMessageKey: z.literal('agents.error.capability_unavailable'),
            }),
            z.object({
              status: z.literal('grounded'),
              kind: z.literal('citation'),
              isAdvice: z.literal(false),
              positionsReferenced: z.literal(false),
              licensedLibraryImported: z.boolean(),
              inventedLibrary: z.literal(false),
              citedCount: z.number().int(),
              citations: z.array(z.object({ slug: z.string(), title: z.string() })),
              userMessageKey: z.literal('agents.error.capability_unavailable'),
            }),
          ]),
        )
        .query(async ({ input }) => {
          const grounding = (await loadCoachGrounding?.()) ?? envCoachGrounding();
          const result = runCoachSession({
            grounding,
            ...(input.ask === undefined ? {} : { ask: input.ask }),
            ...(input.requestedSlug === undefined ? {} : { requestedSlug: input.requestedSlug }),
            ...(input.includePositions === undefined ? {} : { includePositions: input.includePositions }),
            ...(input.asAdvice === undefined ? {} : { asAdvice: input.asAdvice }),
          });
          if (result.status === 'refuse') {
            return {
              status: 'refuse' as const,
              reason: result.reason,
              kind: 'not_advice' as const,
              isAdvice: false as const,
              positionsReferenced: false as const,
              licensedLibraryImported: result.licensedLibraryImported,
              inventedLibrary: false as const,
              citedCount: 0 as const,
              userMessageKey: 'agents.error.capability_unavailable' as const,
            };
          }
          return {
            status: 'grounded' as const,
            kind: 'citation' as const,
            isAdvice: false as const,
            positionsReferenced: false as const,
            licensedLibraryImported: result.licensedLibraryImported,
            inventedLibrary: false as const,
            citedCount: result.citedCount,
            citations: result.citations.map((c) => ({ slug: c.slug, title: c.title })),
            userMessageKey: 'agents.error.capability_unavailable' as const,
          };
        }),
    }),

    /**
     * Growth — campaign proposals (§8.2). Never publishes. Dark warehouse is
     * not a funnel. Returns-ranked copy and incentive budgets are refused.
     * Not a fleet runSession.
     */
    growth: router({
      propose: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            headline: z.string().max(200).optional(),
            copy: z.string().max(2000).optional(),
            publish: z.boolean().optional(),
            incentiveBudget: z.string().max(32).optional(),
            spendAmount: z.string().max(32).optional(),
          }),
        )
        .output(
          z.discriminatedUnion('status', [
            z.object({
              status: z.literal('refuse'),
              reason: z.enum(['warehouse_dark', 'autonomous_publish', 'returns_claim', 'budget_undecided', 'inputs_missing']),
              kind: z.literal('not_a_publication'),
              isPublication: z.literal(false),
              published: z.literal(false),
              warehouseConfigured: z.boolean(),
              warehouseMayLabelLive: z.boolean(),
              inventedReturns: z.literal(false),
              inventedBudget: z.literal(false),
              userMessageKey: z.literal('agents.error.capability_unavailable'),
            }),
            z.object({
              status: z.literal('proposal'),
              kind: z.literal('proposal'),
              isPublication: z.literal(false),
              published: z.literal(false),
              headline: z.string(),
              warehouseConfigured: z.literal(true),
              warehouseMayLabelLive: z.literal(true),
              inventedReturns: z.literal(false),
              inventedBudget: z.literal(false),
              userMessageKey: z.literal('agents.error.capability_unavailable'),
            }),
          ]),
        )
        .mutation(({ input }) => {
          const result = proposeGrowthCampaign({
            warehouse: envGrowthWarehouse(),
            ...(input.headline === undefined ? {} : { headline: input.headline }),
            ...(input.copy === undefined ? {} : { copy: input.copy }),
            ...(input.publish === undefined ? {} : { publish: input.publish }),
            ...(input.incentiveBudget === undefined ? {} : { incentiveBudget: input.incentiveBudget }),
            ...(input.spendAmount === undefined ? {} : { spendAmount: input.spendAmount }),
          });
          if (result.status === 'refuse') {
            return {
              status: 'refuse' as const,
              reason: result.reason,
              kind: 'not_a_publication' as const,
              isPublication: false as const,
              published: false as const,
              warehouseConfigured: result.warehouseConfigured,
              warehouseMayLabelLive: result.warehouseMayLabelLive,
              inventedReturns: false as const,
              inventedBudget: false as const,
              userMessageKey: 'agents.error.capability_unavailable' as const,
            };
          }
          return {
            status: 'proposal' as const,
            kind: 'proposal' as const,
            isPublication: false as const,
            published: false as const,
            headline: result.headline,
            warehouseConfigured: true as const,
            warehouseMayLabelLive: true as const,
            inventedReturns: false as const,
            inventedBudget: false as const,
            userMessageKey: 'agents.error.capability_unavailable' as const,
          };
        }),
    }),

    /**
     * Portfolio — plan-only rebalance inside guardrails (§8.2). Never places.
     * Unwired portfolio port refuses dark — never invented holdings.
     */
    portfolio: router({
      plan: scopedProcedure('agents:read', { module: 'agents' })
        .input(
          z.object({
            targets: z
              .array(
                z.object({
                  asset: z.string().min(1).max(32),
                  plane: z.enum(['custodial', 'sovereign']),
                  weight: z.string().max(32),
                }),
              )
              .optional(),
          }),
        )
        .output(
          z.object({
            result: z.discriminatedUnion('status', [
              z.object({
                status: z.literal('planned'),
                userId: z.string(),
                legs: z.array(
                  z.object({
                    asset: z.string(),
                    plane: z.enum(['custodial', 'sovereign']),
                    currentWeight: z.string(),
                    targetWeight: z.string(),
                    deltaWeight: z.string(),
                    intent: z.enum(['increase', 'reduce']),
                  }),
                ),
              }),
              z.object({
                status: z.literal('refused'),
                code: z.enum([
                  'portfolio.killed',
                  'portfolio.port_dark',
                  'portfolio.target_unset',
                  'portfolio.holding_unread',
                  'portfolio.cross_plane_blocked',
                  'portfolio.price_unset',
                ]),
                userMessageKey: z.literal('agents.refused.module_not_allowed'),
                asset: z.string().nullable(),
              }),
            ]),
          }),
        )
        .query(({ ctx, input }) =>
          guard(async () => {
            const userId = ctx.principal.userId;
            if (!portfolioLedger || !portfolioPrices) {
              const outcome = planRebalance({ userId, targets: input.targets }, { portfolio: null });
              if (outcome.result.status === 'planned') {
                return { result: { ...outcome.result, legs: outcome.result.legs.map((leg) => ({ ...leg })) } };
              }
              return { result: { ...outcome.result, asset: null } };
            }
            const loaded = await readOwnHoldings({ ledger: portfolioLedger, prices: portfolioPrices, userId });
            if (!loaded.ok) {
              return {
                result: {
                  status: 'refused' as const,
                  code: 'portfolio.price_unset' as const,
                  userMessageKey: 'agents.refused.module_not_allowed' as const,
                  asset: loaded.asset,
                },
              };
            }
            const outcome = planRebalance(
              { userId, targets: input.targets },
              {
                portfolio: {
                  read: (id) => {
                    if (id !== userId) {
                      return { holdings: [], unread: [{ asset: id, plane: 'unknown', reason: 'not_caller' }] };
                    }
                    return loaded.snapshot;
                  },
                },
              },
            );
            if (outcome.result.status === 'planned') {
              return { result: { ...outcome.result, legs: outcome.result.legs.map((leg) => ({ ...leg })) } };
            }
            return { result: { ...outcome.result, asset: null } };
          }),
        ),
    }),

    /**
     * Marketplace install (PTX-M28-R12 / R-agentic).
     *
     * Recording a package is not a grant. Claims stay claims: no place, no
     * withdraw, no withdrawal credential. A later grant is a separate act.
     */
    marketplace: router({
      install: executeProcedure()
        .input(
          z.object({
            packageId: z.string().min(1).max(64),
            version: z.string().min(1).max(64),
            publisher: z.string().min(1).max(64),
            claimedTools: z.array(z.string().min(1).max(120)).max(50).optional(),
            claimedScopes: z.array(z.string().min(1).max(64)).max(20).optional(),
            claimedCapacityMode: z.string().min(1).max(64).optional(),
          }),
        )
        .output(
          z.object({
            status: z.literal('installed'),
            packageId: z.string(),
            version: z.string(),
            publisher: z.string(),
            claimedTools: z.array(z.string()),
            claimedScopes: z.array(z.string()),
            grantCreated: z.literal(false),
            tradingAuthority: z.literal(false),
            withdrawCredentialIssued: z.literal(false),
            callable: z.literal(false),
            placeAllowed: z.literal(false),
            withdrawAllowed: z.literal(false),
          }),
        )
        .mutation(({ input }) => marketplaceInstallDoor(input)),
    }),

    /** User spend caps (AG-spend-01). A blank cap refuses. A reservation is not a ledger post. */
    spend: spendRouter(sql),
  });
}

export type AgentsRouter = ReturnType<typeof createAgentsRouter>;
