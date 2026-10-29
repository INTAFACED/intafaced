/**
 * Algo TWAP: the schedule emits children and the parent holds no value.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { TradingControlError } from '../../controls/trading-controls.js';
import { businessPayload } from '../../controls/business-payload.js';
import { requireScope, type Principal } from '@intafaced/auth';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { queryCandlesFromFills } from '../candles.js';
import { deriveAlgoResultFromTotals, loadAlgoChildFillTotals, type AlgoResult } from '../../algo/algo-result.js';
import { newestSchedulerHeartbeat, readSchedulerState, type AlgoSchedulerView } from '../../algo/scheduler-heartbeat.js';
import { orderIdFor } from '../ids.js';
import { assertMarketOpen, assertQty, assertSettlementRails, assertSpotSurface, assertTradable } from '../risk.js';
import { assertSubAccountOwned } from '../sub-account-ownership.js';
import { assertEmailProved } from '../email-proof.js';
import { MatchingNoBookError, type EngineDepth } from '../matching-client.js';
import { presentAlgoProgress, type AlgoProgressView, type CreateTwapInput, type TwapParent } from '../../algo/index.js';
import { captureAlgoPlaceGrant, parseAlgoPlaceGrant, principalFromAlgoGrant } from '../../algo/durable-principal.js';
import { gateAlgoCreate } from '../../algo/create-gate.js';
import { alignLookbackVolumes, sliceCount, timeframeForSliceInterval } from '../../algo/volume-plan.js';
import type { TwapParentRecord } from '../../algo/parent-store.js';
import { hydrateAlgoFromStore, hydrateAlgoIfMissing, persistAlgoCancelAttempt, persistAlgoMutation } from '../../algo/hydrate-on-mutate.js';
import { TradeError, type OrderSide } from '../types.js';
import type { TradeServiceInternal } from '../trade-service.js';

// ── Algo TWAP (D-S-04) — schedule emits children; parent holds no value ─────

/**
 * Create a TWAP schedule. Refuses when market not listed/tradable/open.
 * Does not post to the ledger. Children place through `placeOrder` on tick.
 */
export async function createTwap(
  svc: TradeServiceInternal,
  principal: Principal,
  input: {
    symbol?: string;
    marketId?: string;
    side: OrderSide;
    totalQty: Amount;
    durationMs: number;
    sliceIntervalMs: number;
    limitPrice?: Amount | null;
    subAccountId?: string;
    clientAlgoId?: string;
    /** `twap` (default), `vwap` (lookback candles), `pov` (live tape × participationBps). */
    kind?: string;
    participationBps?: number;
    /** TWAP only: random slice sizes fixed by this seed. */
    randomSeed?: number;
    /** TWAP only: the schedule starts when the mark reaches this price. */
    triggerPrice?: Amount;
  },
): Promise<TwapParent> {
  requireScope(principal, 'trade:write');
  if (!svc.algoEnabled) {
    throw new TradeError('algo execution is disabled by the operator kill-switch', 'trade.algo_disabled');
  }
  if (!svc.spotEnabled) {
    throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
  }
  const kind = (input.kind ?? 'twap').toLowerCase();
  if (kind !== 'twap' && kind !== 'vwap' && kind !== 'pov') {
    throw new TradeError(
      `algo kind "${kind}" is not available — v1 is TWAP / VWAP / POV (icebergs still out)`,
      'trade.algo_unsupported_kind',
    );
  }

  // Replay returns the stored parent and does not re-run the creation gate,
  // so a later balance change cannot turn the same clientAlgoId into a refusal.
  const replay = await svc.replayStoredAlgo(principal.userId, input.clientAlgoId);
  if (replay) return replay;

  const market = await svc.requireMarket(input);
  // TWAP is spot-only by name (see `assertSpotSurface`), not because
  // `assertTradable` happens to refuse the kind.
  assertSpotSurface(market, kind === 'twap' ? 'TWAP' : kind === 'vwap' ? 'VWAP' : 'POV');
  assertTradable(market);
  assertSettlementRails(market);
  assertMarketOpen(market, svc.now());
  assertQty(market, input.totalQty);
  if (input.subAccountId) {
    await assertSubAccountOwned(svc.subAccounts, principal.userId, input.subAccountId);
  }
  // Every child slice is a custodial order; refuse the schedule up front (RC-identity-01).
  if (!market.paper) await assertEmailProved(svc.emailProof, principal.userId);

  // Refuse at creation when mark feed is blank — never accept a schedule that cannot run.
  // Matching 404 (engine holds no book) is a named refusal, not a 500. Nothing
  // is held or stored yet: the gate, admission and parent save all come later.
  let depth: EngineDepth;
  try {
    depth = await svc.matching.depth(market.id, 1);
  } catch (err) {
    if (err instanceof MatchingNoBookError) {
      throw new TradeError(`${market.symbol}: matching holds no book — refusing algo at creation`, 'trade.no_book');
    }
    throw err;
  }
  const bid = depth.bids[0] ? parseAmount(depth.bids[0][0]) : null;
  const ask = depth.asks[0] ? parseAmount(depth.asks[0][0]) : null;
  if (bid === null || ask === null) {
    throw new TradeError(
      `${market.symbol}: no two-sided mark at creation — refusing algo rather than inventing a feed`,
      'trade.algo_mark_missing',
    );
  }

  let createInput: CreateTwapInput = {
    marketId: market.id,
    symbol: market.symbol,
    side: input.side,
    totalQty: input.totalQty,
    durationMs: input.durationMs,
    sliceIntervalMs: input.sliceIntervalMs,
    limitPrice: input.limitPrice ?? null,
    subAccountId: input.subAccountId ?? null,
    clientAlgoId: input.clientAlgoId,
    kind,
  };

  if (input.randomSeed !== undefined) createInput = { ...createInput, randomSeed: input.randomSeed };
  if (input.triggerPrice !== undefined) {
    // The side of the mid the trigger sits on fixes its direction: above waits for the mark to rise to it.
    createInput = { ...createInput, triggerPrice: input.triggerPrice, triggerAbove: input.triggerPrice > (bid + ask) / 2n };
  }

  if (kind === 'vwap') {
    const tf = timeframeForSliceInterval(input.sliceIntervalMs);
    if (tf == null) {
      throw new TradeError(
        'VWAP sliceIntervalMs must match a listed OHLCV timeframe (1m, 5m, 1h, …) — refuse rather than invent a finer volume bucket',
        'trade.algo_invalid_schedule',
      );
    }
    const n = sliceCount(input.durationMs, input.sliceIntervalMs);
    const nowMs = svc.now().getTime();
    const windowEndMs = Math.floor(nowMs / input.sliceIntervalMs) * input.sliceIntervalMs;
    const candles = await queryCandlesFromFills(svc.sql, {
      marketId: market.id,
      timeframe: tf,
      limit: n + 2,
      sinceMs: windowEndMs - n * input.sliceIntervalMs,
    });
    createInput = {
      ...createInput,
      volumeProfile: alignLookbackVolumes(candles, n, input.sliceIntervalMs, windowEndMs),
    };
  }

  if (kind === 'pov') {
    createInput = { ...createInput, participationBps: input.participationBps };
  }

  await gateAlgoCreate({
    sql: svc.sql,
    ledger: svc.ledger,
    perks: svc.perks,
    feeSchedule: await svc.feeScheduleAt(svc.now()),
    slippageCapBps: svc.slippageCapBps,
    markPolicy: svc.algoMarkPolicy,
    now: svc.now(),
    userId: principal.userId,
    market,
    input: createInput,
    bid,
    ask,
    verification: { policy: svc.botVerification, tier: principal.tier },
  });

  // A preview must not emit the store callback or expose an active parent
  // before its durable owner admission. Children are separate decisions.
  const { parent, plan } = svc.algo.prepare(principal.userId, createInput, market.lotSize);
  await svc.admitAccountOperation(
    principal,
    'strategy.start',
    `algo:${parent.id}`,
    businessPayload({ request: input, parent, plan, grant: captureAlgoPlaceGrant(principal) }),
    undefined,
    input.subAccountId,
  );
  await svc.algoStore.save({ parent, plan, grant: captureAlgoPlaceGrant(principal) });
  svc.algoPrincipals.set(principal.userId, principal);
  svc.algo.hydrate(parent, plan);
  return parent;
}

/** Owner recovery restores only the immutable admitted proposal. Each child
 * still needs a fresh identity decision and local trading admission. */
export async function recoverAdmittedAlgo(svc: TradeServiceInternal, userId: string, parentId: string): Promise<TwapParent | null> {
  const existing = await svc.algoStore.load(parentId);
  if (existing) return existing.parent.userId === userId ? existing.parent : null;
  if (!svc.accountAdmission) throw new TradingControlError('authority.unavailable');
  const original = await svc.accountAdmission.resolve(userId, `algo:${parentId}`);
  if (!original) return null;
  const wire = original.payload as { parent: Record<string, unknown>; plan: string[]; grant: unknown };
  if (
    wire.parent?.id !== parentId ||
    wire.parent.userId !== userId ||
    !Array.isArray(wire.plan) ||
    !Array.isArray(wire.parent.children) ||
    wire.parent.children.length !== 0 ||
    !Array.isArray(wire.parent.misses) ||
    wire.parent.misses.length !== 0
  )
    throw new TradingControlError('operation.conflict');
  const parent = {
    ...wire.parent,
    totalQty: parseAmount(String(wire.parent.totalQty)),
    limitPrice: wire.parent.limitPrice == null ? null : parseAmount(String(wire.parent.limitPrice)),
    lotSize: wire.parent.lotSize == null ? null : parseAmount(String(wire.parent.lotSize)),
    createdAt: new Date(String(wire.parent.createdAt)),
    startedAt: new Date(String(wire.parent.startedAt)),
    nextDueAt: new Date(String(wire.parent.nextDueAt)),
    projectedEndsAt: new Date(String(wire.parent.projectedEndsAt)),
    triggerPrice: wire.parent.triggerPrice == null ? null : parseAmount(String(wire.parent.triggerPrice)),
    triggeredAt: null,
    pausedAt: null,
    children: [],
    misses: [],
  } as unknown as TwapParent;
  const record = { parent, plan: wire.plan.map(parseAmount), grant: parseAlgoPlaceGrant(wire.grant) };
  // Recovery must never rewind a parent that another worker already advanced.
  await svc.algoStore.save(record, true);
  const saved = await svc.algoStore.load(parentId);
  if (!saved || saved.parent.userId !== userId) throw new TradingControlError('operation.conflict');
  svc.algo.hydrate(saved.parent, saved.plan);
  svc.installAlgoPlaceGrant(saved);
  return saved.parent;
}

export async function algoProgress(svc: TradeServiceInternal, principal: Principal, parentId: string): Promise<AlgoProgressView> {
  const parent = await svc.getAlgo(principal, parentId);
  // Aggregated in SQL over every child fill: no per-child page cap, and a
  // child whose order row is gone does not fail the read.
  const totals = await loadAlgoChildFillTotals(
    svc.sql,
    principal.userId,
    parent.children.map((child) => child.orderId),
    '',
  );
  return presentAlgoProgress(parent, totals?.filledQty ?? 0n, await svc.algoScheduler());
}

/** Derived child-fill result. Does not write. Does not put money on the parent. */
export async function algoResult(svc: TradeServiceInternal, principal: Principal, parentId: string): Promise<AlgoResult> {
  const parent = await svc.getAlgo(principal, parentId);
  const arrival = await svc.algoStore.loadArrivalMark(parentId);
  const markets = await svc.sql<Array<{ quote_asset: string }>>`
    SELECT quote_asset FROM markets WHERE id = ${parent.marketId}
  `;
  const quoteAsset = markets[0]?.quote_asset;
  if (!quoteAsset) throw new TradeError(`market ${parent.marketId} not found`, 'trade.market_not_found');
  const totals = await loadAlgoChildFillTotals(
    svc.sql,
    principal.userId,
    parent.children.map((child) => child.orderId),
    quoteAsset,
  );
  return deriveAlgoResultFromTotals({
    side: parent.side,
    quoteAsset,
    totals: totals ? [totals] : [],
    arrivalPrice: arrival?.price ?? null,
  });
}

/** Heartbeat read. Selects only. */
export async function algoScheduler(svc: TradeServiceInternal): Promise<AlgoSchedulerView> {
  const newestTickAt = svc.algoJobsEnabled ? await newestSchedulerHeartbeat(svc.sql) : null;
  return readSchedulerState({
    jobsEnabled: svc.algoJobsEnabled,
    intervalMs: svc.algoJobsIntervalMs,
    newestTickAt,
    now: svc.now(),
  });
}

export async function resumeAlgo(svc: TradeServiceInternal, principal: Principal, parentId: string): Promise<TwapParent> {
  requireScope(principal, 'trade:write');
  const parent = await hydrateAlgoIfMissing(svc.algo, svc.algoStore, principal.userId, parentId);
  await svc.admitAccountOperation(
    principal,
    'strategy.start',
    `algo.resume:${orderIdFor(principal.userId, parent.id, `${parent.nextSliceIndex}:${parent.pausedAt?.toISOString() ?? 'none'}`)}`,
    businessPayload({ parentId, nextSliceIndex: parent.nextSliceIndex, pausedAt: parent.pausedAt }),
  );
  return persistAlgoMutation(svc.algo, svc.algoStore, svc.algo.resume(principal.userId, parentId));
}

export async function cancelAlgo(svc: TradeServiceInternal, principal: Principal, parentId: string): Promise<TwapParent> {
  requireScope(principal, 'trade:write');
  // Install the live caller's principal BEFORE engine.cancel so cancelChild
  // can cancel open children after a process restart. Place still refuses
  // without a durable principal grant (SOCKET §13) — cancel is different:
  // the user is presenting authority right now.
  svc.algoPrincipals.set(principal.userId, principal);
  await hydrateAlgoIfMissing(svc.algo, svc.algoStore, principal.userId, parentId);
  return persistAlgoCancelAttempt(svc.algo, svc.algoStore, principal.userId, parentId);
}

/** Drive one parent's next due slice (job host / tests). */
export async function tickAlgo(svc: TradeServiceInternal, parentId: string) {
  await hydrateAlgoFromStore(svc.algo, svc.algoStore, parentId);
  const loaded = await svc.algoStore.load(parentId);
  if (loaded) svc.installAlgoPlaceGrant(loaded);
  const result = await svc.algo.tick(parentId);
  const live = svc.algo.get(parentId);
  if (live) await persistAlgoMutation(svc.algo, svc.algoStore, live);
  return result;
}

/** Drive all active algos once. Hydrates durable active parents first. */
export async function tickAllAlgos(svc: TradeServiceInternal) {
  const active = await svc.algoStore.listActive();
  for (const rec of active) {
    if (!svc.algo.get(rec.parent.id)) {
      svc.algo.hydrate(rec.parent, rec.plan);
    }
    svc.installAlgoPlaceGrant(rec);
  }
  await svc.algo.tickAll();
  for (const rec of active) {
    const live = svc.algo.get(rec.parent.id);
    if (live) await persistAlgoMutation(svc.algo, svc.algoStore, live);
  }
}

/**
 * Same id formula as `TwapEngine.prepare`. Returns the caller's stored parent
 * when this clientAlgoId was already admitted. A foreign row is not returned.
 */
export async function replayStoredAlgo(
  svc: TradeServiceInternal,
  userId: string,
  clientAlgoId: string | undefined,
): Promise<TwapParent | null> {
  const trimmed = clientAlgoId?.trim();
  if (!trimmed) return null;
  const id = `algo-${userId.slice(0, 8)}-${trimmed}`;
  const live = svc.algo.get(id);
  if (live) return live.userId === userId ? live : null;
  const stored = await svc.algoStore.load(id);
  if (!stored || stored.parent.userId !== userId) return null;
  return stored.parent;
}

/**
 * Reinstall the createTwap place grant after restart. Missing/expired grant
 * leaves the in-memory map empty so placeChild still halts.
 */
export function installAlgoPlaceGrant(svc: TradeServiceInternal, record: TwapParentRecord): void {
  if (!record.grant) return;
  try {
    const restored = principalFromAlgoGrant({
      userId: record.parent.userId,
      grant: record.grant,
      expiresAt: record.parent.projectedEndsAt,
      now: svc.now(),
    });
    svc.algoPrincipals.set(restored.userId, restored);
  } catch {
    svc.algoPrincipals.delete(record.parent.userId);
  }
}
