import 'server-only';
import { readKillSwitches } from '@/lib/control-plane-client';
import type { KillSwitchSnapshot } from '@/lib/control-plane-contract';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { parseEffectiveFees, type EffectiveFees } from './fees-model';
import { killStateOutcome } from './kill-switch-model';
import type { Outcome } from './outcome';

/**
 * The reads every desk room shares, with hand-written parsers: a body that is not the expected shape is refused
 * (trade_ops.unexpected_shape), never half-shown. All money and quantities stay decimal STRINGS.
 */

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
/** Decimal string: digits with an optional fraction. Anything else (NaN, 1e9, "") is not a quantity. */
const dec = (v: unknown): v is string => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);

// ── Markets ─────────────────────────────────────────────────────────────────

export type MarketRecordStatus = 'pending' | 'active' | 'halted' | 'delisted';

export interface MarketRow {
  readonly id: string;
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  readonly kind: 'spot' | 'futures' | 'options';
  /** The svc-trade market-record status (pending / active / halted / delisted). The richer lifecycle state is read per symbol. */
  readonly status: MarketRecordStatus;
  readonly tickSize: string;
  readonly lotSize: string;
  readonly minQty: string;
  readonly maxQty: string | null;
  readonly minNotional: string;
  /** Listing metadata. NOT what customers are charged: see readEffectiveFees. */
  readonly makerBps: number;
  readonly takerBps: number;
  readonly listedAt: string | null;
}

function parseMarket(v: unknown): MarketRow | null {
  if (!rec(v)) return null;
  const kinds = ['spot', 'futures', 'options'];
  const statuses = ['pending', 'active', 'halted', 'delisted'];
  if (!str(v.id) || !str(v.symbol) || !str(v.base) || !str(v.quote)) return null;
  if (!str(v.kind) || !kinds.includes(v.kind) || !str(v.status) || !statuses.includes(v.status)) return null;
  if (!dec(v.tickSize) || !dec(v.lotSize) || !dec(v.minQty) || !dec(v.minNotional)) return null;
  if (!(v.maxQty === null || dec(v.maxQty))) return null;
  if (typeof v.makerBps !== 'number' || typeof v.takerBps !== 'number' || !strOrNull(v.listedAt ?? null)) return null;
  return {
    id: v.id,
    symbol: v.symbol,
    base: v.base,
    quote: v.quote,
    kind: v.kind as MarketRow['kind'],
    status: v.status as MarketRecordStatus,
    tickSize: v.tickSize,
    lotSize: v.lotSize,
    minQty: v.minQty,
    maxQty: v.maxQty as string | null,
    minNotional: v.minNotional,
    makerBps: v.makerBps,
    takerBps: v.takerBps,
    listedAt: (v.listedAt as string | null | undefined) ?? null,
  };
}

/** tRPC markets.list (public query on svc-trade). */
export function readMarkets(ctx: TradeCtx, limit = 200): Promise<Outcome<readonly MarketRow[]>> {
  return edgeCall(
    ctx,
    trpcSpec('trade', 'markets.list', 'query', { limit }, (raw) => {
      if (!Array.isArray(raw)) return null;
      const rows = raw.map(parseMarket);
      return rows.every((r): r is MarketRow => r !== null) ? rows : null;
    }),
  );
}

/**
 * GET /api/v1/admin/fees (scope admin:read): the fee schedule customers are charged, per market, with its source.
 * An unpublished schedule answers 503 trade.fee_schedule_blank, which arrives here as a refusal: never a guessed number.
 * The maker/taker bps on a MarketRow are listing metadata and are not charged.
 */
export function readEffectiveFees(ctx: TradeCtx): Promise<Outcome<EffectiveFees>> {
  return edgeCall(ctx, { method: 'GET', path: '/api/v1/admin/fees', parse: parseEffectiveFees });
}

// ── Market lifecycle (authoritative status) ─────────────────────────────────

export const LIFECYCLE_STATES = [
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'PRELAUNCH',
  'AUCTION',
  'OPEN',
  'POST_ONLY',
  'LIMIT_ONLY',
  'CANCEL_ONLY',
  'REDUCE_ONLY',
  'HALTED',
  'EXPIRING',
  'EXPIRED',
  'SETTLING',
  'SETTLED',
  'DELISTING',
  'REFUSED',
  'ARCHIVED',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export interface LifecycleRow {
  readonly state: LifecycleState;
  readonly reasonCategory: string;
  readonly reasonCode: string;
  readonly effectiveAt: string;
  readonly observedAt: string;
  readonly lastGoodState: LifecycleState | null;
  readonly allowedActions: readonly string[];
  readonly transitionId: string;
}

/** GET /api/v1/market-lifecycle/:symbol (public). 503 trade.lifecycle_authority_unavailable when the authority is not wired. */
export function readLifecycle(ctx: TradeCtx, symbol: string): Promise<Outcome<LifecycleRow>> {
  return edgeCall(ctx, {
    method: 'GET',
    path: `/api/v1/market-lifecycle/${encodeURIComponent(symbol)}`,
    parse: (raw) => {
      if (!rec(raw) || !str(raw.state) || !(LIFECYCLE_STATES as readonly string[]).includes(raw.state)) return null;
      if (!str(raw.reasonCategory) || !str(raw.reasonCode) || !str(raw.effectiveAt) || !str(raw.observedAt) || !str(raw.transitionId))
        return null;
      if (!Array.isArray(raw.allowedActions) || !raw.allowedActions.every(str)) return null;
      const last = raw.lastGoodState;
      if (!(last === null || (str(last) && (LIFECYCLE_STATES as readonly string[]).includes(last)))) return null;
      return {
        state: raw.state as LifecycleState,
        reasonCategory: raw.reasonCategory,
        reasonCode: raw.reasonCode,
        effectiveAt: raw.effectiveAt,
        observedAt: raw.observedAt,
        lastGoodState: last as LifecycleState | null,
        allowedActions: raw.allowedActions as string[],
        transitionId: raw.transitionId,
      };
    },
  });
}

// ── Open orders across accounts (operator read) ─────────────────────────────

export type OrderStatusWord = 'open' | 'closed' | 'canceled' | 'expired' | 'rejected';

export interface AdminOrderRow {
  readonly id: string;
  readonly userId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: string;
  readonly timeInForce: string;
  readonly price: string | null;
  readonly amount: string;
  readonly filled: string;
  readonly remaining: string;
  readonly cost: string | null;
  readonly status: OrderStatusWord;
  /** True for recovery_required: funds are held and the outcome is not known. Never shown as plain open. */
  readonly held: boolean;
  readonly recoveryReason: string | null;
  readonly reconciliationKey: string | null;
  readonly seeded: boolean;
  readonly datetime: string;
  readonly clientOrderId: string | null;
}

function parseOrder(v: unknown): AdminOrderRow | null {
  if (!rec(v) || !str(v.id) || !str(v.userId) || !str(v.symbol) || !str(v.datetime)) return null;
  if (v.side !== 'buy' && v.side !== 'sell') return null;
  if (!str(v.type) || !str(v.timeInForce) || !str(v.status) || typeof v.seeded !== 'boolean') return null;
  if (!['open', 'closed', 'canceled', 'expired', 'rejected'].includes(v.status)) return null;
  if (!(v.price === null || dec(v.price)) || !dec(v.amount) || !dec(v.filled) || !dec(v.remaining) || !(v.cost === null || dec(v.cost)))
    return null;
  return {
    id: v.id,
    userId: v.userId,
    symbol: v.symbol,
    side: v.side,
    type: v.type,
    timeInForce: v.timeInForce,
    price: v.price as string | null,
    amount: v.amount,
    filled: v.filled,
    remaining: v.remaining,
    cost: v.cost as string | null,
    status: v.status as OrderStatusWord,
    held: v.recoveryRequired === true,
    recoveryReason: str(v.recoveryReason) ? v.recoveryReason : null,
    reconciliationKey: str(v.reconciliationKey) ? v.reconciliationKey : null,
    seeded: v.seeded,
    datetime: v.datetime,
    clientOrderId: str(v.clientOrderId) ? v.clientOrderId : null,
  };
}

/** GET /api/v1/admin/orders/open?limit= (scope admin:read). The limit is required by the service: never defaulted by it. */
export function readOpenOrders(ctx: TradeCtx, limit = 200): Promise<Outcome<readonly AdminOrderRow[]>> {
  return edgeCall(ctx, {
    method: 'GET',
    path: '/api/v1/admin/orders/open',
    query: { limit },
    parse: (raw) => {
      if (!Array.isArray(raw)) return null;
      const rows = raw.map(parseOrder);
      return rows.every((r): r is AdminOrderRow => r !== null) ? rows : null;
    },
  });
}

// ── Kill switches (edge control plane) ──────────────────────────────────────

/**
 * Which modules are stopped, why, and the audit tail. The edge's /admin/kill-switches takes only the console's server-side
 * operator token (`admin:write` plus MFA); no founder session carries that scope, so this goes through `readKillSwitches()`
 * and never signs with the session.
 */
export async function readKillSwitchSnapshot(): Promise<Outcome<KillSwitchSnapshot>> {
  return killStateOutcome(await readKillSwitches());
}
