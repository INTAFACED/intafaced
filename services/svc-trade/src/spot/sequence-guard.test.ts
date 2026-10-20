import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MatchingNoBookError,
  MatchingUnavailableError,
  type EngineDepth,
  type EngineSubmitRequest,
  type EngineSubmitResult,
  type MatchingClient,
} from './matching-client.js';
import { checkEngineSequences, describeRegressions, describeUnavailable, probeEngineSequence } from './sequence-guard.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE, restsInFull } from './testing.js';
import { TradeService } from '../controls/test-admission.js';
import type { Market } from './types.js';

/**
 * THE ENGINE FORGOT, AND THE PROBE SAYS SO.
 *
 * `insertFillLeg` (#899) already refuses a reused sequence at settlement, so
 * nothing is mis-settled either way. What this guard changes is WHO FINDS OUT:
 * a load balancer reading `/ready`, or the first user whose order is refused.
 *
 * The assertions are about the answers that are easy to get wrong: behind,
 * ahead, a missing book after fills already exist, and a market that has
 * never traded. A missing book on a market that already has fills is a
 * regression. It is not an unjudged skip, and the next submit must not start
 * the counter again.
 */

/**
 * Depth reports either a live counter or no book. Submit, if reached, starts
 * a fresh counter at 1 and can hand that sequence to a new match.
 */
class RestartProbe implements MatchingClient {
  submits = 0;

  constructor(
    private readonly engineSequence: number | null,
    private readonly onSubmit: 'rest' | 'reuse-stored-fill',
  ) {}

  async depth(): Promise<EngineDepth> {
    if (this.engineSequence === null) throw new MatchingNoBookError('probe');
    return { bids: [], asks: [], sequence: this.engineSequence };
  }

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submits += 1;
    if (this.onSubmit === 'rest') return restsInFull(request, 1);
    return {
      accepted: true,
      sequence: 1,
      fills: [
        {
          sequence: 1,
          makerOrderId: '00000000-0000-4000-8000-000000000001',
          makerAccountId: BOB,
          takerOrderId: request.orderId,
          takerAccountId: request.accountId,
          takerSide: request.side,
          price: '100',
          qty: request.qty,
        },
      ],
      resting: null,
      rejected: null,
      cancellations: [],
      triggered: [],
    };
  }

  async cancel(): Promise<never> {
    throw new Error('unused');
  }

  async massCancel(): Promise<never> {
    throw new Error('unused');
  }

  async amend(): Promise<never> {
    throw new Error('unused');
  }

  async markTrailingStops(): Promise<never> {
    throw new Error('unused');
  }

  async listOrders(): Promise<never> {
    throw new Error('unused');
  }

  async listMarkets(): Promise<never> {
    throw new Error('unused');
  }

  async reconcile(): Promise<never> {
    throw new Error('unused');
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade sequence-guard is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade sequence-guard (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  let trade: TradeService;
  let btcusdt: Market;

  beforeEach(async () => {
    await sql`TRUNCATE trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    const ledger = new MemoryLedger();
    trade = new TradeService(sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    btcusdt = await trade.listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });

    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `a-${Math.random()}` }),
    );
    await ledger.post(recipes.deposit({ userId: BOB, assetId: 'BTC', amount: amt('10'), rail: 'test', railRef: `b-${Math.random()}` }));
  });

  /** Record a settled fill at a chosen sequence, without going through the engine. */
  async function recordFillAt(sequence: number): Promise<void> {
    const orderId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    await sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, side, type, price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, session_id
      ) VALUES (
        ${orderId}, ${BOB}, ${btcusdt.id}, 'sell', 'limit', ${'100'}::numeric, ${'1'}::numeric,
        'open', 'GTC', 'BTC', ${'1'}::numeric, 0, ${'99999999-9999-4999-8999-999999999999'}
      )
    `;
    await sql`
      INSERT INTO trade.fills (
        id, order_id, counter_order_id, market_id, user_id, side, liquidity,
        price, qty, quote_amount, fee_asset, fee_amount, fee_bps, sequence
      ) VALUES (
        ${orderId}, ${orderId}, ${orderId}, ${btcusdt.id}, ${BOB}, 'sell', 'maker',
        ${'100'}::numeric, ${'1'}::numeric, ${'100'}::numeric, 'USDT', ${'0'}::numeric, 0, ${sequence}
      )
    `;
  }

  const guard = (engineSequence: (marketId: string) => Promise<number | null>) =>
    checkEngineSequences({ sql, markets: () => trade.markets(50), engineSequence });

  it('REPORTS a counter that is behind what we already settled', async () => {
    await recordFillAt(500);

    // The engine came back with an empty journal and restarted at 3.
    const result = await guard(async () => 3);

    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]?.engineSequence).toBe(3);
    expect(result.regressions[0]?.recordedSequence).toBe(500);
    expect(result.regressions[0]?.symbol).toBe('BTC/USDT');
    expect(result.checked).toBe(1);
  });

  it('is quiet when the engine is ahead, which is the healthy shape', async () => {
    await recordFillAt(500);

    // Always ahead in a healthy system: the engine spends a sequence on every
    // accept and cancel too, not only on fills.
    const result = await guard(async () => 812);

    expect(result.regressions).toHaveLength(0);
    expect(result.checked).toBe(1);
  });

  it('treats EQUAL as healthy — the last operation was the last recorded fill', async () => {
    await recordFillAt(42);
    const result = await guard(async () => 42);
    expect(result.regressions).toHaveLength(0);
  });

  it('does not judge a market that has never traded', async () => {
    // No fills: there is nothing to be behind of, and a fresh engine at 0 is
    // correct rather than corrupt.
    const result = await guard(async () => 0);

    expect(result.regressions).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.unjudged).toBe(1);
  });

  it('REPORTS a missing book when fills are already recorded', async () => {
    await recordFillAt(500);

    // The book is gone. That is not an idle market: fills already name sequences.
    // Counting it unjudged leaves /ready up, and the next submit starts the counter again.
    const result = await guard(async () => null);

    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]?.engineSequence).toBeNull();
    expect(result.regressions[0]?.recordedSequence).toBe(500);
    expect(result.regressions[0]?.symbol).toBe('BTC/USDT');
    expect(result.checked).toBe(1);
    expect(result.unjudged).toBe(0);
    const message = describeRegressions(result.regressions);
    expect(message).toContain('BTC/USDT');
    expect(message).toContain('500');
    expect(message).toContain('missing');
    expect(message).not.toMatch(/engine 0\b/);
  });

  it('leaves a market that never traded unjudged when the engine holds no book', async () => {
    const result = await guard(async () => null);

    expect(result.regressions).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.unjudged).toBe(1);
  });

  async function placeAfter(probe: RestartProbe, clientOrderId: string) {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `place-${clientOrderId}` }),
    );
    const placing = new TradeService(sql, ledger, probe, new StubPerks(), new MemoryEventBus('svc-trade'), {
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 200,
    });
    return placing.placeOrder(principalFor(ALICE), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      price: amt('100'),
      qty: amt('0.01'),
      clientOrderId,
    });
  }

  it('does not restart the sequence counter when the book is missing and fills are stored', async () => {
    await recordFillAt(1);
    const probe = new RestartProbe(null, 'reuse-stored-fill');

    await expect(placeAfter(probe, 'missing-book-submit')).rejects.toMatchObject({
      code: 'trade.engine_sequence_regressed',
    });

    expect(probe.submits).toBe(0);
    const fills = await sql<Array<{ sequence: number }>>`
      SELECT sequence FROM trade.fills WHERE market_id = ${btcusdt.id}
    `;
    expect(fills).toHaveLength(1);
    expect(Number(fills[0]?.sequence)).toBe(1);
    const orders = await sql<Array<{ id: string }>>`
      SELECT id FROM trade.orders WHERE client_order_id = ${'missing-book-submit'}
    `;
    expect(orders).toHaveLength(0);
  });

  it('does not submit when the engine sequence is behind the recorded max', async () => {
    await recordFillAt(500);
    const probe = new RestartProbe(3, 'rest');

    await expect(placeAfter(probe, 'behind-submit')).rejects.toMatchObject({
      code: 'trade.engine_sequence_regressed',
    });
    expect(probe.submits).toBe(0);
  });

  it('still submits on a market that has never traded when the engine has no book', async () => {
    const probe = new RestartProbe(null, 'rest');

    const order = await placeAfter(probe, 'first-trade');

    expect(probe.submits).toBe(1);
    expect(order.status).toBe('open');
  });

  it('preserves transport uncertainty instead of calling it a missing or restarted book', async () => {
    await recordFillAt(500);
    const probe = new RestartProbe(500, 'rest');
    const unavailable = new Error('depth transport failed');
    probe.depth = async () => {
      throw unavailable;
    };
    await expect(placeAfter(probe, 'unknown-book-submit')).rejects.toBe(unavailable);
    expect(probe.submits).toBe(0);
    const orders = await sql<Array<{ id: string }>>`
      SELECT id FROM trade.orders WHERE client_order_id = ${'unknown-book-submit'}
    `;
    expect(orders).toHaveLength(0);
  });

  it('keeps malformed depth counters unavailable instead of declaring them healthy', async () => {
    await recordFillAt(500);
    for (const counter of [Number.NaN, Number.POSITIVE_INFINITY, -1, 500.5, Number.MAX_SAFE_INTEGER + 1]) {
      const probe = new RestartProbe(counter, 'rest');
      await expect(placeAfter(probe, `invalid-counter-${counter}`)).rejects.toMatchObject({ code: 'trade.matching_unavailable' });
      expect(probe.submits).toBe(0);
      const result = await guard(async () => counter);
      expect(result.regressions).toHaveLength(0);
      expect(result.checked).toBe(0);
      expect(result.unavailable).toHaveLength(1);
    }
  });

  it('judges the reply against a fill that settled while the depth probe was in flight', async () => {
    await recordFillAt(50);
    const probe = new RestartProbe(100, 'rest');
    // The previous engine's delayed fill settles at 200 while the restarted engine answers 100.
    probe.depth = async () => {
      await recordFillAt(200);
      return { bids: [], asks: [], sequence: 100 };
    };

    await expect(placeAfter(probe, 'race-submit')).rejects.toMatchObject({ code: 'trade.engine_sequence_regressed' });

    expect(probe.submits).toBe(0);
    const orders = await sql<Array<{ id: string }>>`
      SELECT id FROM trade.orders WHERE client_order_id = ${'race-submit'}
    `;
    expect(orders).toHaveLength(0);
  });

  it('reports a successful depth reply without a counter as unavailable, not as a missing book', async () => {
    await recordFillAt(500);
    const probe = new RestartProbe(500, 'rest');
    probe.depth = async () => ({ bids: [], asks: [], sequence: null }) as unknown as EngineDepth;

    await expect(placeAfter(probe, 'null-counter-submit')).rejects.toMatchObject({ code: 'trade.matching_unavailable' });
    expect(probe.submits).toBe(0);
  });

  it('keeps an unreachable engine out of the regression list at readiness', async () => {
    await recordFillAt(500);

    const result = await guard(async () => {
      throw new MatchingUnavailableError('svc-matching /depth failed (503): down');
    });

    expect(result.regressions).toHaveLength(0);
    expect(result.checked).toBe(0);
    expect(result.unavailable).toEqual([{ marketId: btcusdt.id, symbol: 'BTC/USDT', reason: 'svc-matching /depth failed (503): down' }]);
    const message = describeUnavailable(result.unavailable);
    expect(message).toContain('BTC/USDT');
    expect(message).not.toMatch(/journal|replay/i);
    // /ready is unauthenticated through the edge: upstream response text stays in the log.
    expect(message).not.toContain('down');
    expect(message).not.toContain('/depth');
  });

  it('returns the original order on retry while sequence probing is unavailable', async () => {
    const probe = new RestartProbe(null, 'rest');
    const original = await placeAfter(probe, 'retry-original');
    await recordFillAt(500);
    probe.depth = async () => {
      throw new Error('depth transport failed');
    };
    const retried = await placeAfter(probe, 'retry-original');
    expect(retried.id).toBe(original.id);
    expect(retried.holdAmount).toBe(original.holdAmount);
    expect(probe.submits).toBe(1);
  });

  it('probes three distinct outcomes: a counter, a known missing book, and unknown', async () => {
    await expect(probeEngineSequence(async () => ({ sequence: 7 }), 'm')).resolves.toBe(7);
    await expect(
      probeEngineSequence(async () => {
        throw new MatchingNoBookError('m');
      }, 'm'),
    ).resolves.toBeNull();
    const outage = new MatchingUnavailableError('unreachable');
    await expect(
      probeEngineSequence(async () => {
        throw outage;
      }, 'm'),
    ).rejects.toBe(outage);
    for (const sequence of [null, undefined, '7', -1, 1.5]) {
      await expect(probeEngineSequence(async () => ({ sequence }) as unknown as EngineDepth, 'm')).rejects.toMatchObject({
        code: 'trade.matching_unavailable',
      });
    }
  });

  it('names the market and both numbers, because a count cannot be acted on', () => {
    const message = describeRegressions([{ marketId: 'm-1', symbol: 'BTC/USDT', engineSequence: 3, recordedSequence: 500 }]);

    expect(message).toContain('BTC/USDT');
    expect(message).toContain('3');
    expect(message).toContain('500');
    expect(message).toContain('journal');
  });
});
