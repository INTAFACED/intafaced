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
const mutate = vi.fn((module: string, procedure: string, input: unknown) => {
  calls.push({ procedure, input });
  const answer = answers.get(procedure);
  return answer === undefined ? new Promise(() => undefined) : Promise.resolve(answer);
});
vi.mock('../../session/session', () => ({ useApi: () => ({ query, mutate }) }));
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

describe('Pool fees (D-fees-governance-04)', () => {
  const fees = {
    pool: POOL,
    factory: `0x${'f'.repeat(40)}`,
    feeBps: 30,
    shares: [{ to: 'liquidity_providers', bps: 10_000 }],
    thirdShare: false,
    contract: 'ConstantProductPool v1',
    blockNumber: '42',
  };
  const day = { pool, window: { since: '', seconds: 86_400 }, volume1: '0', swaps: 0, candles: [], asOf: '2026-10-30T13:00:00.000Z' };
  const region = () => host.querySelector('section[aria-label="Fees"]');
  const requestButton = () => Array.from(region()!.querySelectorAll('button')).find((b) => b.textContent === 'Request a protocol fee')!;

  it('reads the pool’s own fee from the protocol service and states no third share', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    answers.set('amm.poolFees', { ok: true, data: fees });
    await show(<PoolPage address={POOL} />);
    expect(region()?.textContent).toContain('Swap fee 0.30% of each swap’s input');
    expect(Array.from(region()!.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      'Liquidity providers, kept in the pool: 100.00% of the swap fee',
    ]);
    expect(region()?.textContent).not.toContain('The indexer recorded');
    expect(host.querySelector('[data-testid="pool-fee-third"]')?.textContent).toMatch(/^There is no third share/);
    expect(region()?.textContent).toContain('Read from the pool contract at block 42.');
    expect(calls.find((call) => call.procedure === 'amm.poolFees')?.input).toEqual({ pool: POOL });
  });

  it('a protocol fee request with the policy blank shows the refusal by name', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    answers.set('amm.poolFees', { ok: true, data: fees });
    answers.set('amm.requestProtocolFee', {
      ok: false,
      reason: 'refused',
      code: 'protocol.fee_policy_unset',
      message: 'protocol.fee_policy_unset: the protocol fee policy is not set.',
    });
    await show(<PoolPage address={POOL} />);
    await act(async () => requestButton().click());
    await act(async () => undefined);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/^Not requested: the protocol fee policy is not set\./);
    expect(calls.find((call) => call.procedure === 'amm.requestProtocolFee')?.input).toEqual({ pool: POOL });
  });

  it('any other refusal of the request names its own reason, never the policy', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    answers.set('amm.poolFees', { ok: true, data: fees });
    answers.set('amm.requestProtocolFee', { ok: false, reason: 'unreachable', message: 'The service did not answer.' });
    await show(<PoolPage address={POOL} />);
    await act(async () => requestButton().click());
    await act(async () => undefined);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Not requested: The service did not answer.');
  });

  it('a protocol outage is worded as the protocol service, never the indexer, and never as a machine code', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    answers.set('amm.poolFees', { ok: false, reason: 'unreachable', code: 'edge.upstream_unavailable', message: 'x' });
    await show(<PoolPage address={POOL} />);
    expect(region()?.textContent).toContain('The pool’s fee fields were not read: the protocol service didn’t answer');
    expect(region()?.textContent).not.toContain('indexer');
    answers.set('amm.poolFees', { ok: false, reason: 'refused', message: 'protocol.chain_unreachable: The chain did not answer.' });
    await act(async () =>
      Array.from(region()!.querySelectorAll('button'))
        .find((b) => b.textContent === 'Try again')!
        .click(),
    );
    await act(async () => undefined);
    expect(region()?.textContent).toContain('not read: the network’s node didn’t answer');
    expect(region()?.textContent).not.toContain('protocol.chain_unreachable');
  });

  it('an unexpected acceptance is never shown as a refusal', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    answers.set('amm.poolFees', { ok: true, data: fees });
    answers.set('amm.requestProtocolFee', { ok: true, data: {} });
    await show(<PoolPage address={POOL} />);
    await act(async () => requestButton().click());
    await act(async () => undefined);
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('Not requested');
  });

  it('a fee the contract answers differently from the indexer’s record is named, and the contract’s is shown', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    answers.set('amm.poolFees', { ok: true, data: { ...fees, feeBps: 100 } });
    await show(<PoolPage address={POOL} />);
    expect(host.querySelector('[data-testid="pool-fee"]')?.textContent).toMatch(/^Swap fee 1\.00%/);
    expect(region()?.textContent).toContain('The indexer recorded a 0.30% fee');
  });

  it('a pool the protocol service does not recognise gets no fee claim', async () => {
    answers.set('explorer.pools.get', { ok: true, data: day });
    answers.set('amm.poolFees', {
      ok: false,
      reason: 'not_found',
      code: 'protocol.not_factory_pool',
      message: 'protocol.not_factory_pool: x',
    });
    await show(<PoolPage address={POOL} />);
    expect(region()?.textContent).toContain('does not recognise this pool');
    expect(region()?.textContent).not.toContain('There is no third share');
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
