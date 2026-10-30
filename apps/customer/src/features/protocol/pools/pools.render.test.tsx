// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const answers = new Map<string, unknown>();
const calls: Array<{ procedure: string; input: unknown }> = [];
const query = vi.fn((module: string, procedure: string, input: unknown) => {
  calls.push({ procedure, input });
  if (module === 'protocol' && procedure === 'chainStatus') return Promise.resolve({ ok: true, data: { configuredChainId: 84532 } });
  const answer = answers.get(procedure);
  return answer === undefined ? new Promise(() => undefined) : Promise.resolve(answer);
});
vi.mock('../../session/session', () => ({ useApi: () => ({ query }) }));
import { PoolsList } from './PoolsList';
import { PoolPage } from './PoolPage';
import { candleGeometry, compareDecimal } from './PriceChart';
import { bpsPercent } from './format';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const POOL = `0x${'9'.repeat(40)}`;
const A = { address: `0x${'a'.repeat(40)}`, symbol: 'TESTA', name: 'TEST Token A', decimals: 6 };
const B = { address: `0x${'b'.repeat(40)}`, symbol: 'TESTB', name: 'TEST Token B', decimals: 18 };
const pool = {
  chainId: 84532,
  address: POOL,
  factory: `0x${'f'.repeat(40)}`,
  token0: A,
  token1: B,
  feeBps: 30,
  createdHeight: 4,
  createdTx: `0x${'c'.repeat(64)}`,
  reserves: { reserve0: '1000000000', reserve1: '2000000000000000000000', height: 9 },
};
let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? '';

async function show(node: React.ReactNode) {
  await act(async () => root.render(node));
  await act(async () => undefined);
}

beforeEach(() => {
  answers.clear();
  calls.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Pools list', () => {
  it('lists each pool with its pair link, fee and reserves in each token’s own decimals', async () => {
    answers.set('explorer.pools.list', { ok: true, data: { rows: [pool], nextCursor: null, asOf: '' } });
    await show(<PoolsList />);
    const link = host.querySelector(`a[href="/dex/pools/${POOL}"]`);
    expect(link?.textContent).toBe('TESTA / TESTB');
    // A symbol alone can be anyone's: each token's contract address is shown beside it.
    expect(text()).toContain('0xaaaaaaaa…aaaaaa / 0xbbbbbbbb…bbbbbb');
    expect(text()).toContain('Check the contract address.');
    expect(text()).toContain('0.30%');
    expect(text()).toContain('1000 TESTA · 2000 TESTB');
    expect(calls.find((call) => call.procedure === 'explorer.pools.list')?.input).toEqual({ chainId: 84532 });
  });
  it('keeps the table and names a blank factory', async () => {
    answers.set('explorer.pools.list', { ok: false, code: 'PRECONDITION_FAILED', message: 'indexer.pool_factory_unset' });
    await show(<PoolsList />);
    expect(host.querySelector('[aria-label="Pools"] table, table')).not.toBeNull();
    expect(text()).toContain('The pool list was not read: indexer.pool_factory_unset');
  });
});

describe('Pool page', () => {
  const day = {
    pool,
    window: { since: '', seconds: 86_400 },
    volume1: '3500000000000000000',
    swaps: 2,
    candles: [{ start: 1_700_000_000, open: '2', high: '2.5', low: '1', close: '1', volume1: '3500000000000000000', swaps: 2 }],
    asOf: '2026-10-30T13:00:00.000Z',
  };
  const swaps = {
    rows: [
      {
        hash: `0x${'1'.repeat(64)}`,
        blockHeight: 9,
        logIndex: 1,
        timestamp: 1_700_000_100,
        side: 'buy',
        amount0In: '0',
        amount1In: '2500000000000000000',
        amount0Out: '1000000',
        amount1Out: '0',
      },
      {
        hash: `0x${'2'.repeat(64)}`,
        blockHeight: 8,
        logIndex: 1,
        timestamp: 1_700_000_050,
        side: 'sell',
        amount0In: '1000000',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '1000000000000000000',
      },
    ],
    nextCursor: null,
    asOf: '',
  };

  it('shows the facts, a price chart, the day’s volume and trades as buys and sells of the first token', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    answers.set('explorer.pools.swaps', { ok: true, data: swaps });
    await show(<PoolPage address={POOL} />);
    expect(text()).toContain('Pool TESTA / TESTB');
    expect(host.querySelector(`a[href="/dex/tokens/${A.address}"]`)?.textContent).toBe('TEST Token A (TESTA)');
    const chart = host.querySelector('[role="img"]');
    expect(chart?.getAttribute('aria-label')).toBe('Price chart: TESTA in TESTB, last 24 hours, 1 hour candles');
    expect(host.querySelectorAll('[data-testid="pool-candle"]')).toHaveLength(1);
    expect(text()).toContain('Low 1 · high 2.5 TESTB per TESTA');
    expect(host.querySelector('[data-testid="pool-volume"]')?.textContent).toBe('3.5 TESTB in the last 24 hours, 2 swaps');
    const rows = Array.from(host.querySelectorAll('tr[data-side]')).map((row) => row.textContent);
    expect(rows[0]).toContain('Buy TESTA');
    expect(rows[0]).toContain('0 in · 1 out');
    expect(rows[1]).toContain('Sell TESTA');
    expect(calls.find((call) => call.procedure === 'explorer.pools.get')?.input).toEqual({ chainId: 84532, address: POOL, interval: '1h' });
  });

  it('asks again at the other candle width', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    await show(<PoolPage address={POOL} />);
    const five = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '5 minute')!;
    await act(async () => five.click());
    await act(async () => undefined);
    expect(
      calls.filter((call) => call.procedure === 'explorer.pools.get').map((call) => (call.input as { interval: string }).interval),
    ).toEqual(['1h', '5m']);
  });

  it('says the price was not read when a token never said its decimals, never a guessed scale', async () => {
    answers.set('explorer.pools.get', { ok: true, data: { ...day, candles: null } });
    await show(<PoolPage address={POOL} />);
    expect(host.querySelector('[role="img"]')).toBeNull();
    expect(text()).toContain('The price was not read: a token in this pool did not say its decimals.');
  });

  it('places candles at their own time, so a quiet stretch is a gap', () => {
    const day = { start: 0, seconds: 86_400, width: 3600 };
    const candle = (start: number) => ({ start, open: '1', high: '2', low: '1', close: '2', volume1: '0', swaps: 1 });
    const placed = candleGeometry([candle(0), candle(3600), candle(82_800)], day)!;
    expect(placed[1]!.x - placed[0]!.x).toBeCloseTo(600 / 24);
    expect(placed[2]!.x - placed[1]!.x).toBeCloseTo((600 / 24) * 22);
  });

  it('another not-found is a refusal, never a claim that the address is not a pool', async () => {
    answers.set('explorer.pools.get', { ok: false, code: 'NOT_FOUND', message: 'No procedure found on path "explorer.pools.get"' });
    await show(<PoolPage address={POOL} />);
    expect(text()).not.toContain('is not a pool');
    expect(text()).toContain('This pool was not read');
  });

  it('an address the factory did not create reads not a pool', async () => {
    answers.set('explorer.pools.get', { ok: false, code: 'NOT_FOUND', message: 'indexer.not_a_pool' });
    await show(<PoolPage address={POOL} />);
    expect(text()).toContain(`${POOL} is not a pool on`);
    expect(host.querySelector('[data-code="indexer.not_a_pool"]')).not.toBeNull();
  });
});

describe('pool figures', () => {
  it('compares decimals exactly and writes basis points without a float', () => {
    expect(compareDecimal('0.10000000000000000001', '0.1')).toBe(1);
    expect(compareDecimal('2', '10')).toBe(-1);
    expect(compareDecimal('1.50', '1.5')).toBe(0);
    expect(bpsPercent(30)).toBe('0.30');
    expect(bpsPercent(1000)).toBe('10.00');
  });
  it('draws nothing for no candles, and a flat day without dividing by zero', () => {
    expect(candleGeometry([], { start: 0, seconds: 86_400, width: 3600 })).toBeNull();
    const flat = candleGeometry([{ start: 0, open: '1', high: '1', low: '1', close: '1', volume1: '0', swaps: 1 }], {
      start: 0,
      seconds: 86_400,
      width: 3600,
    });
    expect(flat?.[0]?.wick.y1).toBeTypeOf('number');
    expect(Number.isFinite(flat?.[0]?.wick.y1)).toBe(true);
  });
});
