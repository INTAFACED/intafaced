import { BASE_PERKS, type RankPerks } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type {
  EngineAmendRequest,
  EngineAmendResult,
  EngineCancelResult,
  EngineCancellation,
  EngineDepth,
  EngineFill,
  EngineMassCancelRequest,
  EngineMassCancelResult,
  EngineSubmitRequest,
  EngineSubmitResult,
  MatchingClient,
} from './matching-client.js';
import { massCancelSessionRefuse, readSessionId } from './matching-client.js';
import type { RankPerksSource } from './rank-perks.js';
import type { SubAccountOwnershipSource } from './sub-account-ownership.js';
import type { EmailProofSource } from './email-proof.js';
import type { SubAccountOwnership } from '@intafaced/contracts';
import { TradeError } from './types.js';
import { decideMarketAction, type MarketLifecyclePort } from '../market-lifecycle.js';
import type { Market } from './types.js';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';
import { parseFeeScheduleJson, type OwnerFeeSchedule } from './fee-schedule.js';

/** Owner-published test schedule as decimal strings — never a JSON number. */
export const PUBLISHED_TEST_FEE_SCHEDULE: OwnerFeeSchedule = parseFeeScheduleJson(
  JSON.stringify({ published: true, version: 'test', makerBps: '10', takerBps: '20' }),
);

/**
 * Explicit test-only PX-S01 authority. Production must inject the SQL-backed
 * authority; this fixture makes the test's admission fact visible rather than
 * relying on the production refuse-closed default.
 */
export const READY_MARKET_LIFECYCLE: MarketLifecyclePort = {
  snapshot(market): MarketStateSnapshot {
    const observedAt = '2026-08-24T16:00:00.000Z';
    return {
      marketId: market.id,
      ruleVersion: 'test.rules.v1',
      instrumentId: market.id,
      instrumentVersion: 'test.instrument.v1',
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: observedAt,
      observedAt,
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE', 'PLACE_POST_ONLY', 'AMEND', 'CANCEL', 'REDUCE', 'CLOSE', 'TRIGGER', 'QUOTE', 'RFQ'],
      transitionId: `test.transition:${market.id}`,
      evidenceRefs: [`test.evidence:${market.id}`],
    };
  },
  admit(snapshot, action) {
    return decideMarketAction(snapshot, action);
  },
};

/** Stable clock paired with READY_MARKET_LIFECYCLE for MM seed fixtures. */
export const READY_MARKET_NOW = (): Date => new Date('2026-08-24T16:00:00.000Z');

/** Full catalog-shaped market for MM tests, including lifecycle identity. */
export function readyMarket(marketId: string, overrides: Partial<Market> = {}): Market {
  return {
    id: marketId,
    symbol: overrides.symbol ?? 'BTC/USDT',
    baseAsset: overrides.baseAsset ?? 'BTC',
    quoteAsset: overrides.quoteAsset ?? 'USDT',
    kind: overrides.kind ?? 'spot',
    tickSize: overrides.tickSize ?? parseAmount('0.01'),
    lotSize: overrides.lotSize ?? parseAmount('0.0001'),
    minQty: overrides.minQty ?? parseAmount('0.0001'),
    maxQty: overrides.maxQty ?? parseAmount('1000'),
    minNotional: overrides.minNotional ?? parseAmount('1'),
    status: overrides.status ?? 'active',
    makerBps: overrides.makerBps ?? 10,
    takerBps: overrides.takerBps ?? 20,
    listedAt: overrides.listedAt ?? null,
    assetClass: overrides.assetClass ?? 'crypto',
    schedule: overrides.schedule ?? 'crypto-24x7',
    paper: overrides.paper ?? false,
  };
}

/**
 * TEST DOUBLES.
 *
 * Why these and not the real engine: §15.2 forbids one service importing
 * another's source, and svc-matching is a separate service with its own 76
 * tests covering the book itself. What is under test here is svc-trade's
 * ORDERING — hold before submit, fills before releases, one release per order —
 * and for that the engine needs to be scriptable, not realistic. A test that
 * had to construct a real book to produce a partial fill would be testing the
 * book.
 *
 * The shapes are svc-matching's published wire contract, decimal strings and
 * all, so a drift between the two would show up as a type error rather than as
 * a production surprise.
 *
 * The ledger, by contrast, is the REAL reference implementation
 * (`MemoryLedger`), which the conformance suite proves equivalent to
 * svc-ledger's Postgres engine. Nothing about money is faked.
 */

/** Builder: the order rests in full, nothing matched. */
export function restsInFull(request: EngineSubmitRequest, sequence: number): EngineSubmitResult {
  return {
    accepted: true,
    sequence,
    fills: [],
    resting: {
      kind: 'book',
      orderId: request.orderId,
      accountId: request.accountId,
      side: request.side,
      price: request.price ?? '0',
      remaining: request.qty,
      sequence,
      version: 1,
    },
    rejected: null,
    cancellations: [],
    triggered: [],
  };
}

export interface ScriptedFill {
  makerOrderId: string;
  makerAccountId: string;
  price: string;
  qty: string;
}

export class StubMatching implements MatchingClient {
  readonly submitted: Array<{ marketId: string; request: EngineSubmitRequest }> = [];
  readonly cancelledOrders: string[] = [];
  readonly massCancels: Array<{ marketId: string; accountId: string }> = [];
  readonly amended: Array<{ marketId: string; orderId: string; request: EngineAmendRequest }> = [];
  readonly listedMarkets: string[] = [];
  /** Remaining qty / version for live orders (native amend + list). */
  readonly liveRemaining = new Map<string, string>();
  readonly liveVersion = new Map<string, number>();
  readonly liveAccount = new Map<string, string>();

  /** Depth answered to `bestAsk`, used to price a market buy. */
  asks: Array<readonly [string, string]> = [];
  bids: Array<readonly [string, string]> = [];

  /** Called before each submit result is produced — lets a test observe ordering. */
  onSubmit: ((request: EngineSubmitRequest) => Promise<void> | void) | null = null;

  private sequence = 0;
  private readonly script: Array<(request: EngineSubmitRequest, next: () => number) => EngineSubmitResult> = [];
  private readonly cancelScript = new Map<string, EngineCancelResult>();
  /**
   * Orders the list endpoint reports as live (orderId → marketId).
   * Default: empty → list miss. Tests that need "engine live" seed this set.
   * When cancel is scripted as a miss, list also reports miss for that id.
   */
  private readonly liveById = new Map<string, string>();

  /** Queue one submit outcome. Unscripted submissions rest in full. */
  script1(fn: (request: EngineSubmitRequest, next: () => number) => EngineSubmitResult): this {
    this.script.push(fn);
    return this;
  }

  /** Queue a submission that fills against an existing resting order. */
  scriptFills(fills: readonly ScriptedFill[], options: { restRemainder?: string; cancelRemainder?: string } = {}): this {
    return this.script1((request, next) => {
      const sequence = next();
      const engineFills: EngineFill[] = fills.map((f) => ({
        sequence: next(),
        makerOrderId: f.makerOrderId,
        makerAccountId: f.makerAccountId,
        takerOrderId: request.orderId,
        takerAccountId: request.accountId,
        takerSide: request.side,
        price: f.price,
        qty: f.qty,
      }));

      return {
        accepted: true,
        sequence,
        fills: engineFills,
        resting: options.restRemainder
          ? {
              kind: 'book',
              orderId: request.orderId,
              accountId: request.accountId,
              side: request.side,
              price: request.price ?? '0',
              remaining: options.restRemainder,
              sequence,
            }
          : null,
        rejected: null,
        cancellations: options.cancelRemainder
          ? [
              {
                orderId: request.orderId,
                accountId: request.accountId,
                remainingQty: options.cancelRemainder,
                sequence: next(),
                reason: 'ioc_remainder',
              },
            ]
          : [],
        triggered: [],
      };
    });
  }

  /** Queue a rejection — post-only would cross, FOK unfillable, and so on. */
  scriptRejection(code: string, message = code): this {
    return this.script1(() => ({
      accepted: false,
      sequence: null,
      fills: [],
      resting: null,
      rejected: { code, message },
      cancellations: [],
      triggered: [],
    }));
  }

  /** Queue a submission that pulls one of the submitter's own resting orders (§5.1 STP). */
  scriptSelfTradePrevention(pulledOrderId: string, accountId: string, remainingQty: string): this {
    return this.script1((request, next) => {
      const sequence = next();
      return {
        accepted: true,
        sequence,
        fills: [],
        resting: {
          kind: 'book',
          orderId: request.orderId,
          accountId: request.accountId,
          side: request.side,
          price: request.price ?? '0',
          remaining: request.qty,
          sequence,
        },
        rejected: null,
        cancellations: [{ orderId: pulledOrderId, accountId, remainingQty, sequence: next(), reason: 'self_trade_prevention' }],
        triggered: [],
      };
    });
  }

  /** The engine reports the order is not live — it already filled, or never arrived. */
  scriptCancelMiss(orderId: string): this {
    this.cancelScript.set(orderId, { cancelled: false, orderId, sequence: null, cancellation: null });
    this.liveById.delete(orderId);
    this.liveRemaining.delete(orderId);
    this.liveVersion.delete(orderId);
    this.liveAccount.delete(orderId);
    return this;
  }

  /** Report order as live on list (and default cancel success unless miss scripted). */
  scriptLive(orderId: string, marketId: string, remaining = '1', version = 1, accountId = ''): this {
    this.liveById.set(orderId, marketId);
    this.liveRemaining.set(orderId, remaining);
    this.liveVersion.set(orderId, version);
    this.liveAccount.set(orderId, accountId);
    return this;
  }

  amendScript: ((marketId: string, orderId: string, request: EngineAmendRequest) => Promise<EngineAmendResult> | EngineAmendResult) | null =
    null;

  async submit(marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submitted.push({ marketId, request });
    // Default list liveness: resting/unscripted submissions appear on the book.
    this.liveById.set(request.orderId, marketId);
    this.liveRemaining.set(request.orderId, request.qty);
    this.liveVersion.set(request.orderId, 1);
    this.liveAccount.set(request.orderId, request.accountId);
    if (this.onSubmit) await this.onSubmit(request);
    const fn = this.script.shift();
    return fn ? fn(request, () => ++this.sequence) : restsInFull(request, ++this.sequence);
  }

  async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    this.cancelledOrders.push(orderId);
    const scripted = this.cancelScript.get(orderId);
    if (scripted) {
      this.liveById.delete(orderId);
      this.liveRemaining.delete(orderId);
      this.liveVersion.delete(orderId);
      this.liveAccount.delete(orderId);
      return scripted;
    }

    // The engine reports what was still unexecuted when it cancelled.
    const remainingQty = this.liveRemaining.get(orderId) ?? '0';
    this.liveById.delete(orderId);
    this.liveRemaining.delete(orderId);
    this.liveVersion.delete(orderId);
    this.liveAccount.delete(orderId);
    const sequence = ++this.sequence;
    return {
      cancelled: true,
      orderId,
      sequence,
      cancellation: { orderId, accountId: '', remainingQty, sequence, reason: 'requested' },
    };
  }

  async massCancel(marketId: string, request: EngineMassCancelRequest): Promise<EngineMassCancelResult> {
    this.massCancels.push({ marketId, accountId: request.accountId });
    const sessionRefuse = massCancelSessionRefuse(readSessionId(request as { sessionId?: string | null }));
    if (sessionRefuse) {
      return { accepted: false, accountId: request.accountId, cancellations: [], rejected: sessionRefuse };
    }
    const cancellations: EngineCancellation[] = [];
    for (const [orderId, liveMarket] of [...this.liveById.entries()]) {
      if (liveMarket !== marketId) continue;
      if (this.liveAccount.get(orderId) !== request.accountId) continue;
      const sequence = ++this.sequence;
      const remaining = this.liveRemaining.get(orderId) ?? '0';
      this.liveById.delete(orderId);
      this.liveRemaining.delete(orderId);
      this.liveVersion.delete(orderId);
      this.liveAccount.delete(orderId);
      cancellations.push({
        orderId,
        accountId: request.accountId,
        remainingQty: remaining,
        sequence,
        reason: 'requested',
      });
    }
    return { accepted: true, accountId: request.accountId, cancellations, rejected: null };
  }

  async amend(marketId: string, orderId: string, request: EngineAmendRequest): Promise<EngineAmendResult> {
    this.amended.push({ marketId, orderId, request });
    if (this.amendScript) return this.amendScript(marketId, orderId, request);

    const liveMarket = this.liveById.get(orderId);
    if (!liveMarket) {
      return {
        accepted: false,
        orderId,
        sequence: null,
        version: null,
        priority: null,
        fills: [],
        resting: null,
        rejected: { code: 'order_not_found', message: `order ${orderId} is not live` },
        cancellations: [],
        triggered: [],
      };
    }
    const expected = this.liveVersion.get(orderId) ?? 1;
    if (request.expectedVersion !== expected) {
      return {
        accepted: false,
        orderId,
        sequence: null,
        version: expected,
        priority: null,
        fills: [],
        resting: null,
        rejected: { code: 'version_mismatch', message: `order ${orderId} is at version ${expected}` },
        cancellations: [],
        triggered: [],
      };
    }
    const previous = parseAmount(this.liveRemaining.get(orderId) ?? '0');
    const remaining = request.qty ?? this.liveRemaining.get(orderId) ?? '0';
    const next = parseAmount(remaining);
    const version = expected + 1;
    this.liveRemaining.set(orderId, remaining);
    this.liveVersion.set(orderId, version);
    const sequence = this.sequence;
    return {
      accepted: true,
      orderId,
      sequence,
      version,
      priority: next > previous ? 'lost' : 'retained',
      fills: [],
      resting: {
        kind: 'book',
        orderId,
        accountId: '',
        side: 'buy',
        price: '0',
        remaining,
        sequence,
        version,
      },
      rejected: null,
      cancellations: [],
      triggered: [],
    };
  }

  async depth(): Promise<EngineDepth> {
    return { bids: this.bids, asks: this.asks, sequence: this.sequence };
  }

  async listOrders(marketId: string, _orderId?: string): Promise<import('./matching-client.js').EngineLiveOrders> {
    this.listedMarkets.push(marketId);
    const orders = [...this.liveById.entries()]
      .filter(([, mid]) => mid === marketId)
      .map(([orderId], i) => ({
        marketId,
        orderId,
        accountId: '',
        kind: 'book' as const,
        side: 'buy' as const,
        price: '0',
        remaining: this.liveRemaining.get(orderId) ?? '0',
        sequence: i + 1,
        version: this.liveVersion.get(orderId) ?? 1,
      }));
    return { marketId, orders };
  }

  /** Default: empty engine set (tests that care set this). */
  engineMarketIds: string[] = [];

  async listMarkets(): Promise<import('./matching-client.js').EngineMarketList> {
    return { markets: [...this.engineMarketIds] };
  }

  async reconcile(): Promise<import('./matching-client.js').ReconcileReport> {
    return { checked: 0, agreed: 0, findings: [], refusals: 0, ok: true };
  }

  /** Every mark the engine was asked to walk trailing stops with. */
  readonly marked: Array<{ marketId: string; mark: string }> = [];

  async markTrailingStops(marketId: string, mark: string): Promise<import('./matching-client.js').EngineMarkResult> {
    this.marked.push({ marketId, mark });
    return { accepted: true, applied: false, rejected: null };
  }

  /**
   * CX-7 F6 — simulate matching **process** death + cold start before journal replay.
   *
   * Real matching restarts clear in-process book/script state but keep a
   * monotonic sequence floor and then re-emit journal events. Tests call this
   * *before* redelivering fill/cancel events so redelivery is not just "same
   * live process, loop again" — the stub no longer holds pre-restart book
   * scripts either.
   */
  simulateProcessRestart(): this {
    this.submitted.length = 0;
    this.cancelledOrders.length = 0;
    this.massCancels.length = 0;
    this.amended.length = 0;
    this.listedMarkets.length = 0;
    this.script.length = 0;
    this.cancelScript.clear();
    this.liveById.clear();
    this.liveRemaining.clear();
    this.liveVersion.clear();
    this.liveAccount.clear();
    this.amendScript = null;
    this.onSubmit = null;
    // Sequence must not go backwards after restart (journal floor).
    this.sequence = Math.max(this.sequence, 1);
    this.asks = [];
    this.bids = [];
    return this;
  }
}

/**
 * H8c — matching 200 then trade death before fill/ack.
 * The engine accepted (rest is live); the caller dies before applySubmitResult.
 * Opposite of SubmitUnknownThenAbsentMatching: list still shows the order.
 */
export class SubmitAcceptedThenDieMatching extends StubMatching {
  override async submit(marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    await super.submit(marketId, request);
    throw new Error('trade died after matching 200 before fill/ack');
  }
}

/**
 * H8c matching retry shape: HTTP 200 + accepted:false + duplicate_order_id.
 * The id is already live; qty/price on the book stay the original decimal strings.
 */
export class DuplicateOrderIdMatching extends StubMatching {
  override async submit(marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    await super.submit(marketId, request);
    return {
      accepted: false,
      sequence: null,
      fills: [],
      resting: null,
      rejected: { code: 'duplicate_order_id', message: `order ${request.orderId} was already accepted` },
      cancellations: [],
      triggered: [],
    };
  }
}

/** Submit may have reached the engine, but a later definitive cancel miss and
 * empty live-order lookup prove the order never remained fillable. */
export class SubmitUnknownThenAbsentMatching extends StubMatching {
  override async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submitted.push({ marketId: _marketId, request });
    throw new Error('submit response timed out after possible dispatch');
  }

  override async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    this.cancelledOrders.push(orderId);
    return { cancelled: false, orderId, sequence: null, cancellation: null };
  }
}

export class CancelTimeoutMatching extends StubMatching {
  override async cancel(_marketId: string, _orderId: string): Promise<EngineCancelResult> {
    throw new Error('cancel transport timed out');
  }
}

/** An engine that cannot be reached. Used to test the indeterminate-submit branch. */
export class UnreachableMatching implements MatchingClient {
  readonly submitted: EngineSubmitRequest[] = [];

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submitted.push(request);
    throw new Error('svc-matching is unreachable');
  }

  async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    // A cancel for an order the engine never took.
    return { cancelled: false, orderId, sequence: null, cancellation: null };
  }

  async massCancel(_marketId: string, _request: EngineMassCancelRequest): Promise<EngineMassCancelResult> {
    throw new Error('svc-matching is unreachable');
  }

  async amend(_marketId: string, _orderId: string, _request: EngineAmendRequest): Promise<EngineAmendResult> {
    throw new Error('svc-matching is unreachable');
  }

  async depth(): Promise<EngineDepth> {
    return { bids: [], asks: [], sequence: 0 };
  }

  async listOrders(_marketId: string): Promise<import('./matching-client.js').EngineLiveOrders> {
    throw new Error('svc-matching is unreachable');
  }

  async listMarkets(): Promise<import('./matching-client.js').EngineMarketList> {
    throw new Error('svc-matching is unreachable');
  }

  async reconcile(): Promise<import('./matching-client.js').ReconcileReport> {
    throw new Error('svc-matching is unreachable');
  }

  async markTrailingStops(): Promise<import('./matching-client.js').EngineMarkResult> {
    throw new Error('svc-matching is unreachable');
  }
}

export class StubPerks implements RankPerksSource {
  readonly discounts = new Map<string, number>();
  /** Set to make the perk source fail, exercising the fail-closed branch. */
  unavailable = false;

  async perksOf(userId: string): Promise<RankPerks> {
    if (this.unavailable) throw new Error('svc-identity is unreachable');
    return { ...BASE_PERKS, feeDiscountBps: this.discounts.get(userId) ?? 0 };
  }
}

/** Scriptable identity S2S for sub-account ownership on placeOrder. */
export class StubSubAccounts implements SubAccountOwnershipSource {
  readonly rows = new Map<string, SubAccountOwnership>();
  /** When true, get() throws the same fail-closed code as a down identity. */
  unavailable = false;
  /** Observed lookups — proves the gate runs before hold. */
  readonly lookedUp: string[] = [];

  seed(row: SubAccountOwnership): this {
    this.rows.set(row.id, row);
    return this;
  }

  async get(subAccountId: string): Promise<SubAccountOwnership | null> {
    this.lookedUp.push(subAccountId);
    if (this.unavailable) {
      throw new TradeError('svc-identity is unreachable', 'trade.sub_account_unavailable');
    }
    return this.rows.get(subAccountId) ?? null;
  }
}

/** A verified session with the given scopes. */
export function principalFor(userId: string, scopes: readonly string[] = ['trade:write']): Principal {
  return {
    sub: userId,
    userId,
    scopes: [...scopes],
    tier: 'basic',
    mfa: false,
    sid: '99999999-9999-4999-8999-999999999999',
    expiresAt: new Date(Date.now() + 3_600_000),
  };
}

/**
 * Email-proof stand-in (RC-identity-01). Every user is proved unless listed in
 * `missing`; `unavailable` throws the same fail-closed code as a down identity.
 */
export class StubEmailProof implements EmailProofSource {
  readonly missing = new Set<string>();
  unavailable = false;
  /** Observed reads — proves the gate runs, and runs before any hold. */
  readonly lookedUp: string[] = [];

  async get(userId: string): Promise<'accepted' | 'missing'> {
    this.lookedUp.push(userId);
    if (this.unavailable) throw new TradeError('svc-identity is unreachable', 'trade.identity_unavailable');
    return this.missing.has(userId) ? 'missing' : 'accepted';
  }
}
