import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { handleSubmitSharePost, submitShare } from './submit-share.js';
import { payWindow } from './epoch-jobs.js';

// Synthetic IDs and terms exercise storage only; these are not published emissions.
const SECRET = 'test-internal-service-secret-32ch!!';
const ALICE = '11111111-1111-4111-8111-111111111111';
const base = { windowId: 'w', assetId: 'IFC', epoch: 7, reward: '10', feeBps: 100, shares: [{ shareId: 'a', minerId: ALICE, weight: 1n }] };
const migration = (name: string) => readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8');
const initial = migration('0000_mining_pool_init.sql');
// Shares now name their worker (0003) and carry their proof of work and mode (0004), so ingest needs the worker table (0002). 0001 stays out of the base so the tests
// below still upgrade populated pre-0001 data to it and reverse it.
const workers = [migration('0002_mining_reads.sql'), migration('0003_share_workers.sql'), migration('0004_pow_solo.sql')];

describe('native mining storage safeguards', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required for native mining proof');
    db = await createTestDatabase({ service: 'mining_pool', url: process.env.TEST_DATABASE_URL, migrations: [initial, ...workers] });
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE mining_pool.shares, mining_pool.windows, mining_pool.workers CASCADE`;
  });
  const post = async (body: unknown, sql = db.sql) => {
    const rawBody = Buffer.from(JSON.stringify(body));
    return handleSubmitSharePost({ rawBody, sql, secret: SECRET, headers: serviceAuthHeadersForBody('svc-cron', SECRET, rawBody) });
  };
  const wire = (input = base) => ({ ...input, shares: input.shares.map((s) => ({ ...s, weight: s.weight.toString() })) });

  it('reports the numeric/null stored epoch without quoting batch payouts', async () => {
    expect(await post(wire())).toEqual({ status: 200, body: { accepted: true, settled: false, epoch: 7 } });
    expect(await post({ ...wire(), shares: [{ shareId: 'b', minerId: ALICE, weight: '3' }] })).toEqual({
      status: 200,
      body: { accepted: true, settled: false, epoch: 7 },
    });
    expect(await post({ ...wire(), windowId: 'unset', epoch: null, shares: [{ shareId: 'unset', minerId: ALICE, weight: '1' }] })).toEqual({
      status: 200,
      body: { accepted: true, settled: false, epoch: null },
    });
  });

  it('refuses every changed immutable term before appending shares, including null epochs', async () => {
    await submitShare(db.sql, base);
    for (const changed of [{ assetId: 'BTC' }, { reward: '11' }, { feeBps: 0 }, { epoch: 8 }, { epoch: undefined }]) {
      await expect(submitShare(db.sql, { ...base, ...changed, shares: [{ shareId: 'b', minerId: ALICE, weight: 1n }] })).rejects.toThrow(
        'mining.window_conflict',
      );
    }
    expect(await db.sql`SELECT share_id FROM mining_pool.shares`).toEqual([{ share_id: 'a' }]);
  });

  it('serializes concurrent conflicting creation without diluting the winner', async () => {
    const attempts = await Promise.allSettled([
      submitShare(db.sql, base),
      submitShare(db.sql, { ...base, reward: '11', shares: [{ shareId: 'b', minerId: ALICE, weight: 1n }] }),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await db.sql`SELECT share_id FROM mining_pool.shares`).toHaveLength(1);
  });

  it('rolls back earlier inserts when a later share duplicates an existing identity', async () => {
    await submitShare(db.sql, base);
    await expect(
      submitShare(db.sql, { ...base, shares: [{ shareId: 'new', minerId: ALICE, weight: 1n }, ...base.shares] }),
    ).rejects.toThrow();
    expect(await db.sql`SELECT share_id FROM mining_pool.shares`).toEqual([{ share_id: 'a' }]);
  });

  it('blocks shares on paid windows and preserves decimal-equivalent immutable rewards', async () => {
    await submitShare(db.sql, base);
    await submitShare(db.sql, { ...base, reward: '10.0', shares: [{ shareId: 'b', minerId: ALICE, weight: 2n }] });
    await db.sql`UPDATE mining_pool.windows SET status = 'paid' WHERE window_id = 'w'`;
    await expect(submitShare(db.sql, { ...base, shares: [{ shareId: 'c', minerId: ALICE, weight: 1n }] })).rejects.toThrow(
      'mining.window_paid',
    );
    expect(await db.sql`SELECT share_id FROM mining_pool.shares ORDER BY share_id`).toEqual([{ share_id: 'a' }, { share_id: 'b' }]);
  });

  it('upgrades populated data without rewriting terms, permits null slots, repeats and reverses honestly', async () => {
    await submitShare(db.sql, base);
    const up = migration('0001_blank_reward_share.sql');
    const down = migration('0001_blank_reward_share.down.sql');
    await db.sql.unsafe(up);
    await db.sql.unsafe(up);
    expect((await db.sql`SELECT reward::text AS reward, fee_bps FROM mining_pool.windows`)[0]).toMatchObject({
      reward: '10.000000000000000000',
      fee_bps: 100,
    });
    expect(await post({ windowId: 'blank', assetId: 'IFC', epoch: 9, shares: [{ shareId: 'blank', minerId: ALICE }] })).toEqual({
      status: 200,
      body: { accepted: true, settled: false, epoch: 9, amount: null, shares: [{ shareId: 'blank', minerId: ALICE }] },
    });
    expect((await db.sql`SELECT reward, fee_bps FROM mining_pool.windows WHERE window_id = 'blank'`)[0]).toEqual({
      reward: null,
      fee_bps: null,
    });
    expect((await db.sql`SELECT weight FROM mining_pool.shares WHERE share_id = 'blank'`)[0]).toEqual({ weight: null });
    const ledger = { post: vi.fn() };
    await expect(payWindow(db.sql, ledger, 'blank')).rejects.toThrow('mining.emission_unpublished');
    expect(ledger.post).not.toHaveBeenCalled();
    await expect(
      db.sql.begin(async (tx) => {
        await tx.unsafe(down);
      }),
    ).rejects.toThrow();
    expect((await db.sql`SELECT weight FROM mining_pool.shares WHERE share_id = 'blank'`)[0]).toEqual({ weight: null });
    await db.sql`DELETE FROM mining_pool.shares WHERE window_id = 'blank'`;
    await db.sql`DELETE FROM mining_pool.windows WHERE window_id = 'blank'`;
    await db.sql.unsafe(down);
    await db.sql.unsafe(down);
    await expect(
      db.sql`INSERT INTO mining_pool.windows (window_id, asset_id, reward, fee_bps) VALUES ('null', 'IFC', null, null)`,
    ).rejects.toThrow();
    await db.sql.unsafe(up);
  });

  it('creates a fresh nullable schema, keeps checks and refuses every incomplete payout before ledger calls', async () => {
    const fresh = await createTestDatabase({
      service: 'mining_pool',
      url: process.env.TEST_DATABASE_URL,
      migrations: [initial, migration('0001_blank_reward_share.sql'), ...workers],
    });
    try {
      const blank = { windowId: 'fresh', assetId: 'IFC', shares: [{ shareId: 'fresh', minerId: ALICE, weight: '2' }] };
      expect((await post(blank, fresh.sql)).body).toMatchObject({ accepted: true, epoch: null, amount: null });
      expect((await fresh.sql`SELECT weight::text AS weight FROM mining_pool.shares`)[0]).toEqual({ weight: '2' });
      const ledger = { post: vi.fn() };
      await expect(payWindow(fresh.sql, ledger, 'fresh')).rejects.toThrow('mining.emission_unpublished');
      await fresh.sql`INSERT INTO mining_pool.windows (window_id, epoch, asset_id, reward, fee_bps) VALUES ('weighted', 1, 'IFC', 10, 100)`;
      await fresh.sql`INSERT INTO mining_pool.shares (share_id, window_id, miner_id, weight) VALUES ('weighted', 'weighted', ${ALICE}, null)`;
      await expect(payWindow(fresh.sql, ledger, 'weighted')).rejects.toThrow('mining.emission_unpublished');
      expect(ledger.post).not.toHaveBeenCalled();
      await expect(
        fresh.sql`INSERT INTO mining_pool.windows (window_id, asset_id, reward, fee_bps) VALUES ('zero', 'IFC', 0, null)`,
      ).rejects.toThrow();
      await expect(
        fresh.sql`INSERT INTO mining_pool.windows (window_id, asset_id, reward, fee_bps) VALUES ('fee', 'IFC', null, 10000)`,
      ).rejects.toThrow();
      await expect(
        fresh.sql`INSERT INTO mining_pool.shares (share_id, window_id, miner_id, weight) VALUES ('zero', 'fresh', ${ALICE}, 0)`,
      ).rejects.toThrow();
    } finally {
      await fresh.drop();
    }
  });

  it('appends matching blank shares but refuses blank submissions to funded windows', async () => {
    await db.sql.unsafe(migration('0001_blank_reward_share.sql'));
    const blank = { windowId: 'blank', assetId: 'IFC', shares: [{ shareId: 'blank-a', minerId: ALICE }] };
    expect((await post(blank)).status).toBe(200);
    expect((await post({ ...blank, shares: [{ shareId: 'blank-b', minerId: ALICE, weight: '2' }] })).status).toBe(200);
    await submitShare(db.sql, base);
    expect((await post({ ...blank, windowId: 'w', epoch: 7, shares: [{ shareId: 'c', minerId: ALICE }] })).body).toEqual({
      accepted: false,
      error: 'mining.window_conflict',
    });
    expect(await db.sql`SELECT share_id FROM mining_pool.shares WHERE window_id = 'w'`).toEqual([{ share_id: 'a' }]);
  });

  it('blank windows reject all conflicting terms and paid windows; no false success without SQL or valid identities', async () => {
    await db.sql.unsafe(migration('0001_blank_reward_share.sql'));
    const blank = { windowId: 'blank', assetId: 'IFC', epoch: 9, shares: [{ shareId: 'a', minerId: ALICE }] };
    expect((await post(blank)).status).toBe(200);
    for (const changed of [
      { assetId: 'BTC' },
      { epoch: 8 },
      { epoch: null },
      { reward: '10', feeBps: 100, shares: [{ shareId: 'b', minerId: ALICE, weight: '1' }] },
    ]) {
      expect((await post({ ...blank, ...changed })).body).toEqual({ accepted: false, error: 'mining.window_conflict' });
    }
    await db.sql`UPDATE mining_pool.windows SET status = 'paid' WHERE window_id = 'blank'`;
    expect((await post(blank)).body).toEqual({ accepted: false, error: 'mining.window_paid' });
    const payload = Buffer.from(JSON.stringify(blank));
    expect(
      (
        await handleSubmitSharePost({
          rawBody: payload,
          sql: null,
          secret: SECRET,
          headers: serviceAuthHeadersForBody('svc-cron', SECRET, payload),
        })
      ).body,
    ).toEqual({ accepted: false, error: 'mining.pg_unavailable' });
    for (const changed of [
      { windowId: ' ' },
      { assetId: '' },
      { shares: [{ shareId: '', minerId: ALICE }] },
      { shares: [{ shareId: 'b', minerId: ' ' }] },
      { epoch: '9' },
      { epoch: -1 },
      { epoch: 2147483648 },
      { feeBps: 100 },
      { shares: [{ shareId: 'b', minerId: ALICE, weight: '0' }] },
      { shares: [{ shareId: 'b', minerId: ALICE, weight: '-1' }] },
      { shares: [{ shareId: 'b', minerId: ALICE, weight: 'no' }] },
      { shares: [{ shareId: 'b', minerId: ALICE, weight: 1 }] },
    ]) {
      expect((await post({ ...blank, windowId: 'other', ...changed })).status).toBe(409);
    }
    expect(await db.sql`SELECT share_id FROM mining_pool.shares`).toEqual([{ share_id: 'a' }]);
  });
});
