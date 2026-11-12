import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlLiveRunStore } from './sql-store.js';
import { liveOrderKey, type LiveOrderRecord, type LiveRunRecord } from './store.js';

/**
 * The live run's rows on Postgres (J-algo-dev-07): an order takes the run's next number under its row lock, two orders
 * at once with the same number admit one, a key again answers the order already written, and a run moves only from the
 * states it is asked to move from.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The live run Postgres test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const USER = '11111111-1111-4111-8111-1111111111b7';
const RUN = 'a7000000-0000-4000-8000-0000000000b7';

const run = (): LiveRunRecord => ({
  userId: USER,
  runId: RUN,
  strategyId: 'trend',
  strategyVersion: 1,
  strategyName: 'TEST trend',
  venueId: 'test-venue',
  owner: '0x00000000000000000000000000000000000000a1',
  subAccount: '0x00000000000000000000000000000000000000a2',
  agentAddress: '0x00000000000000000000000000000000000000a3',
  asset: 'USDC',
  cap: parseAmount('2000'),
  plan: [{ side: 'buy', symbol: 'BTC-PERP', qty: parseAmount('0.01') }],
  restartAttempts: 1,
  statePolicy: 'keep',
  liveControl: true,
  state: 'running',
  endReason: null,
  permission: 'active',
  restarts: 0,
  nextSeq: 1,
  strategyState: { ticks: 0 },
  heartbeatAt: new Date(),
  createdAt: new Date(),
  startedAt: new Date(),
  stoppedAt: null,
  stopSeq: null,
});

const order = (seq: number, over: Partial<LiveOrderRecord> = {}): LiveOrderRecord => ({
  userId: USER,
  runId: RUN,
  seq,
  actionKey: liveOrderKey(RUN, seq),
  kind: 'manual',
  block: null,
  symbol: 'BTC-PERP',
  side: 'buy',
  type: 'limit',
  size: parseAmount('0.005'),
  price: parseAmount('50000'),
  reduceOnly: false,
  state: 'admitted',
  createdAt: new Date(),
  ...over,
});

describe('the live run store on Postgres', () => {
  let db: TestDatabase | undefined;
  let store: SqlLiveRunStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    store = new SqlLiveRunStore(db.sql);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('stores a run once and reads it back exactly, amounts as decimals', async () => {
    const r = run();
    const stored = await store.insertOnce(r);
    expect(stored).toMatchObject({ runId: RUN, cap: parseAmount('2000'), plan: r.plan, nextSeq: 1, state: 'running' });
    expect(await store.insertOnce({ ...r, strategyName: 'other' })).toMatchObject({ strategyName: 'TEST trend' });
    expect((await store.listActive()).map((x) => x.runId)).toEqual([RUN]);
  });

  it('two orders at once under the same number admit one; the key again answers it; the next number moves once', async () => {
    const [x, y] = await Promise.all([
      store.admitOrder(order(1), ['running']),
      store.admitOrder(order(1, { price: parseAmount('49000') }), ['running']),
    ]);
    const outcomes = [x, y].map((o) => Object.keys(o)[0]);
    expect(outcomes.sort()).toEqual(['admitted', 'existing']);
    expect((await store.find(USER, RUN))!.nextSeq).toBe(2);
    expect(await store.admitOrder(order(1), ['running'])).toHaveProperty('existing');
    expect(await store.admitOrder(order(3), ['running'])).toMatchObject({ refused: 'seq' });
    await store.setOrderState(USER, RUN, 1, 'accepted');
    expect((await store.orders(USER, RUN))[0]).toMatchObject({ seq: 1, state: 'accepted', size: parseAmount('0.005') });
  });

  it('moves only from the states asked, keeps the heartbeat only while running, and refuses orders once stopped', async () => {
    expect(await store.beat(USER, RUN, new Date(), { ticks: 4 })).toBe(true);
    expect((await store.move(USER, RUN, ['signing'], { state: 'flat' })).moved).toBe(false);
    const stopped = await store.move(USER, RUN, ['running', 'unknown'], {
      state: 'stopped',
      endReason: 'user_stop',
      stopSeq: 1,
      stoppedAt: new Date(),
    });
    expect(stopped).toMatchObject({
      moved: true,
      run: { state: 'stopped', endReason: 'user_stop', stopSeq: 1, strategyState: { ticks: 4 } },
    });
    expect(await store.beat(USER, RUN, new Date(), { ticks: 5 })).toBe(false);
    expect(await store.admitOrder(order(2), ['running'])).toMatchObject({ refused: 'state' });
    await store.log(USER, RUN, new Date(), 'stopped', 'TEST');
    expect((await store.events(USER, RUN)).map((e) => e.kind)).toEqual(['stopped']);
  });
});
