import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  maintenanceOf,
  rosterStates,
  setAlertLimit,
  setMaintenance,
  settleWorkers,
  workerOne,
  workerStateChanges,
} from './worker-state.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const QUIET = 60;
const migration = (name: string) => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8');

function databaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL required for mining worker states');
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const workerOf = (user: string, name: string) => `worker:${user}:${name}`;

describe('mining worker states', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase({
      service: 'mining_pool',
      url: databaseUrl(),
      migrations: [
        migration('0000_mining_pool_init.sql'),
        migration('0001_blank_reward_share.sql'),
        migration('0002_mining_reads.sql'),
        migration('0003_share_workers.sql'),
        migration('0004_pow_solo.sql'),
        migration('0005_miner_credentials.sql'),
        migration('20261031050905_worker_states.sql'),
      ],
    });
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await db.truncateAll();
    await db.sql`INSERT INTO mining_pool.windows (window_id, asset_id, reward, fee_bps, status) VALUES ('w-1', 'TEST', NULL, NULL, 'open')`;
  });

  async function worker(user: string, name: string): Promise<string> {
    const id = workerOf(user, name);
    await db.sql`INSERT INTO mining_pool.workers (id, user_id, name) VALUES (${id}, ${user}, ${name}) ON CONFLICT DO NOTHING`;
    return id;
  }

  /** One accepted share `secondsAgo` before the database clock. */
  async function share(user: string, workerId: string, label: string, secondsAgo: number): Promise<void> {
    await db.sql`
      INSERT INTO mining_pool.shares (share_id, window_id, miner_id, weight, worker_id, created_at)
      VALUES (${label}, 'w-1', ${user}, 1, ${workerId}, now() - (${secondsAgo}::int * interval '1 second'))
    `;
  }

  const changes = async (workerId: string) =>
    db.sql<{ key: string; from_state: string; to_state: string }[]>`
      SELECT key, from_state, to_state FROM mining_pool.worker_state_changes WHERE worker_id = ${workerId} ORDER BY seq
    `;

  it('a quiet worker gets one offline row; a repeat pass writes none and only moves the evaluation time', async () => {
    const id = await worker(ALICE, 'Rig-Q');
    await share(ALICE, id, 's1', 120);
    expect(await settleWorkers(db.sql, QUIET, null, true)).toEqual({ looked: 1, recorded: 1 });
    const first = await workerStateChanges(db.sql, ALICE, id, QUIET);
    expect(first.rows).toEqual([{ workerId: id, from: 'online', to: 'offline', at: expect.any(String) }]);
    expect(first.evaluatedAt).not.toBeNull();
    const [last] = await db.sql<{ created_at: Date }[]>`SELECT created_at FROM mining_pool.shares WHERE share_id = 's1'`;
    expect((await changes(id))[0]?.key).toBe(`mining:worker-offline:${id}:${last!.created_at.toISOString()}`);

    expect(await settleWorkers(db.sql, QUIET, null, true)).toEqual({ looked: 1, recorded: 0 });
    const again = await workerStateChanges(db.sql, ALICE, id, QUIET);
    expect(again.rows).toEqual(first.rows);
    expect(Date.parse(again.evaluatedAt!)).toBeGreaterThanOrEqual(Date.parse(first.evaluatedAt!));
  });

  it('two evaluators at once still write one row per change', async () => {
    const ids = await Promise.all(['A', 'B', 'C'].map((name) => worker(ALICE, `Rig-${name}`)));
    for (const [i, id] of ids.entries()) await share(ALICE, id, `p${i}`, 300);
    const passes = await Promise.all([1, 2, 3, 4].map(() => settleWorkers(db.sql, QUIET, null, true)));
    expect(passes.reduce((sum, pass) => sum + pass.recorded, 0)).toBe(3);
    for (const id of ids) expect(await changes(id)).toHaveLength(1);
  });

  it('a worker in maintenance gets no row, but the evaluator still stamps its look', async () => {
    const id = await worker(ALICE, 'Rig-M1');
    await share(ALICE, id, 'm1', 120);
    await setMaintenance(db.sql, ALICE, [id], true);
    expect(await settleWorkers(db.sql, QUIET, null, true)).toEqual({ looked: 1, recorded: 0 });
    const read = await workerStateChanges(db.sql, ALICE, id, QUIET);
    expect(read.rows).toEqual([]);
    expect(read.evaluatedAt).not.toBeNull();
    expect((await workerOne(db.sql, ALICE, id, 60, { quietSeconds: QUIET, alertShareBps: null })).state).toBe('maintenance');
    expect(await changes(id)).toEqual([]);
  });

  it('a worker that sends a share again after offline gets one online row keyed on its new share', async () => {
    const id = await worker(ALICE, 'Rig-Q');
    await share(ALICE, id, 'o1', 200);
    await settleWorkers(db.sql, QUIET, null, true);
    await share(ALICE, id, 'o2', 1);
    await settleWorkers(db.sql, QUIET, null, true);
    await settleWorkers(db.sql, QUIET, null, true);
    const rows = await changes(id);
    expect(rows.map((row) => [row.from_state, row.to_state])).toEqual([
      ['online', 'offline'],
      ['offline', 'online'],
    ]);
    expect(rows[1]!.key).toMatch(new RegExp(`^mining:worker-online:${id}:`));
  });

  it('a worker with no share and a worker still sending get no row', async () => {
    const never = await worker(ALICE, 'Rig-N');
    const busy = await worker(ALICE, 'Rig-B');
    await share(ALICE, busy, 'b1', 5);
    expect(await settleWorkers(db.sql, QUIET, null, true)).toEqual({ looked: 2, recorded: 0 });
    expect((await workerOne(db.sql, ALICE, never, 60, { quietSeconds: QUIET, alertShareBps: null })).connectivity).toBe('offline');
  });

  it('workers.one answers the caller own worker: hashing, online, state and a blank alert limit', async () => {
    const id = await worker(ALICE, 'Rig-Q');
    await share(ALICE, id, 'q1', 10);
    await share(ALICE, id, 'q2', 5);
    const one = await workerOne(db.sql, ALICE, id, 60, { quietSeconds: QUIET, alertShareBps: null });
    expect(one).toMatchObject({
      id,
      name: 'Rig-Q',
      hashing: 'hashing',
      hashrate: '2',
      connectivity: 'online',
      state: 'active',
      quietSeconds: QUIET,
      alertLimitMode: null,
      alertLimit: null,
      alertLimitReason: 'mining.alert_limit_unset',
      maintenanceSince: null,
    });
    expect(Date.parse(one.asOf) - Date.parse(one.lastShareAt!)).toBeLessThan(QUIET * 1000);
    await expect(workerOne(db.sql, BOB, id, 60, { quietSeconds: QUIET, alertShareBps: null })).rejects.toMatchObject({
      code: 'mining.worker_not_found',
    });
    await expect(workerStateChanges(db.sql, BOB, id, QUIET)).rejects.toMatchObject({ code: 'mining.worker_not_found' });
  });

  it('a read of a quiet worker records the change once, as the evaluator would, without stamping a look', async () => {
    const id = await worker(ALICE, 'Rig-Q');
    await share(ALICE, id, 'r1', 120);
    const one = await workerOne(db.sql, ALICE, id, 1, { quietSeconds: QUIET, alertShareBps: null });
    expect(one).toMatchObject({
      hashing: 'idle',
      hashrate: null,
      hashrateReason: 'no_shares_in_window',
      connectivity: 'offline',
      state: 'offline',
    });
    await workerOne(db.sql, ALICE, id, 1, { quietSeconds: QUIET, alertShareBps: null });
    const read = await workerStateChanges(db.sql, ALICE, id, QUIET);
    expect(read.rows).toHaveLength(1);
    expect(read.evaluatedAt).toBeNull();
  });

  it('the alert limit: manual is the account value, automatic is the owner share of the trailing weight, and both refuse blank', async () => {
    const id = await worker(ALICE, 'Rig-Q');
    for (const n of [1, 2, 3, 4]) await share(ALICE, id, `a${n}`, n);
    const read = (bps: number | null) => workerOne(db.sql, ALICE, id, 60, { quietSeconds: QUIET, alertShareBps: bps });
    await expect(setAlertLimit(db.sql, ALICE, id, 'manual', null)).rejects.toMatchObject({ code: 'mining.alert_limit_invalid' });
    await expect(setAlertLimit(db.sql, ALICE, id, 'manual', '0')).rejects.toMatchObject({ code: 'mining.alert_limit_invalid' });
    await expect(setAlertLimit(db.sql, ALICE, id, 'automatic', '1')).rejects.toMatchObject({ code: 'mining.alert_limit_invalid' });
    await expect(setAlertLimit(db.sql, BOB, id, 'automatic', null)).rejects.toMatchObject({ code: 'mining.worker_not_found' });

    expect(await setAlertLimit(db.sql, ALICE, id, 'manual', '2.50')).toEqual({ workerId: id, mode: 'manual', manualLimit: '2.5' });
    expect(await read(null)).toMatchObject({ alertLimitMode: 'manual', alertLimit: '2.5', alertLimitReason: null });

    await setAlertLimit(db.sql, ALICE, id, 'automatic', null);
    expect(await read(null)).toMatchObject({ alertLimitMode: 'automatic', alertLimit: null, alertLimitReason: 'mining.alert_limit_unset' });
    expect(await read(2500)).toMatchObject({ alertLimitMode: 'automatic', alertLimit: '1', alertLimitReason: null });
    expect(await workerOne(db.sql, ALICE, id, 60, { quietSeconds: QUIET, alertShareBps: 3333 })).toMatchObject({ alertLimit: '1.3332' });

    await setAlertLimit(db.sql, ALICE, id, null, null);
    expect(await read(2500)).toMatchObject({ alertLimitMode: null, alertLimit: null, alertLimitReason: 'mining.alert_limit_unset' });
  });

  it('maintenance: one row per worker, asking again keeps the first since, a foreign id refuses the whole call, off removes', async () => {
    const ids = await Promise.all(['M1', 'M2', 'M3'].map((name) => worker(ALICE, `Rig-${name}`)));
    const foreign = await worker(BOB, 'Rig-X');
    await expect(setMaintenance(db.sql, ALICE, [...ids, foreign], true)).rejects.toMatchObject({ code: 'mining.worker_not_found' });
    expect((await maintenanceOf(db.sql, ALICE)).rows).toEqual([]);

    const first = await setMaintenance(db.sql, ALICE, ids, true);
    expect(first.rows.map((row) => row.workerId).sort()).toEqual([...ids].sort());
    const again = await setMaintenance(db.sql, ALICE, [...ids, ids[0]!], true);
    expect(again.rows).toEqual(first.rows);
    const keys = await db.sql<{ key: string }[]>`SELECT key FROM mining_pool.worker_maintenance ORDER BY key`;
    expect(keys.map((row) => row.key)).toEqual(ids.map((id) => `mining:maintenance:${id}`).sort());
    expect((await maintenanceOf(db.sql, BOB)).rows).toEqual([]);

    const states = await rosterStates(db.sql, ALICE, [...ids, foreign], QUIET);
    expect([...states.values()].map((row) => row.state)).toEqual(['maintenance', 'maintenance', 'maintenance']);
    expect(states.has(foreign)).toBe(false);

    await setMaintenance(db.sql, ALICE, [ids[0]!], false);
    expect((await maintenanceOf(db.sql, ALICE)).rows.map((row) => row.workerId).sort()).toEqual([ids[1], ids[2]].sort());
    expect((await rosterStates(db.sql, ALICE, [ids[0]!], QUIET)).get(ids[0]!)?.state).toBe('offline');
    expect((await rosterStates(db.sql, ALICE, [ids[0]!], null)).get(ids[0]!)?.state).toBeNull();
  });
});
