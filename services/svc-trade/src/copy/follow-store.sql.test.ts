import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { CopyError } from './errors.js';
import { SqlCopyFollowStore, type StoredPlacedMirror, type StoredSettledFeeShare } from './follow-store.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import type { CopyFollow } from './follows.js';

/**
 * SQL unique fill_id is the crash-safe once-key. Memory exclusive never
 * survives process death; these tests hit the real index.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run `createTestDatabase`, not shared table mutations).
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 *
 * R-copy closed all regions on main — this file does not recut copy geo.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const FOLLOWER = '00000000-0000-4000-8000-000000000001';
const LEADER = '00000000-0000-4000-8000-000000000002';
const LEADER_B = '00000000-0000-4000-8000-000000000003';
const FOLLOW_A = 'aaaa1111-1111-4111-8111-111111111111';
const FOLLOW_B = 'bbbb2222-2222-4222-8222-222222222222';
const FILL = 'fill-sql-claim-before-post';
const PLACE_FILL = 'fill-sql-place-mirror-once';

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
      `H8a: follow-store unique fill_id is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

function follow(followId: string, leaderId: string): CopyFollow {
  return {
    followId,
    followerId: FOLLOWER,
    leaderId,
    envelope: {
      permittedMarkets: ['BTC-USDT'],
      maxNotionalPerOrder: parseAmount('100'),
      maxAggregateExposure: parseAmount('1000'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
    region: 'SG',
    createdAt: new Date('2026-08-14T00:00:00.000Z'),
    feeShareKilled: false,
  };
}

function share(followId: string, fillId: string, leaderId: string): StoredSettledFeeShare {
  return {
    fillId,
    followId,
    leaderId,
    followerId: FOLLOWER,
    assetId: 'USDT',
    protocolFee: parseAmount('1'),
    appliedShareBps: 5000,
    grossLeaderShare: parseAmount('0.5'),
    cappedLeaderShare: parseAmount('0.5'),
    skippedReason: null,
    settled: true,
  };
}

function placedMirror(followId: string, fillId: string): StoredPlacedMirror {
  return {
    followId,
    fillId,
    orderId: 'order-sql-place-1',
    clientOrderId: 'client-order-sql-1',
    price: parseAmount('5000'),
  };
}

describe('SqlCopyFollowStore PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('SqlCopyFollowStore fee-share claim-before-post', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await truncateTradeExceptOrderEvents(db!.sql);
  });

  it('relationship_state round-trips pause without dropping the follow', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow({ ...follow(FOLLOW_A, LEADER), relationshipState: 'PAUSED' });
    const loaded = await store.getFollow(FOLLOW_A);
    expect(loaded?.relationshipState).toBe('PAUSED');
    expect(loaded?.followId).toBe(FOLLOW_A);
  });

  it('permitted_markets is stored as a JSON array and reads back, so the follow can mirror its markets', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    const base = follow(FOLLOW_A, LEADER);
    await store.saveFollow({ ...base, envelope: { ...base.envelope, permittedMarkets: ['BTC-USDT', 'ETH-USDT'] } });
    const raw = await db!.sql<Array<{ kind: string; n: number }>>`
      SELECT jsonb_typeof(permitted_markets) AS kind, jsonb_array_length(permitted_markets) AS n
      FROM copy_follows WHERE follow_id = ${FOLLOW_A}
    `;
    expect(raw[0]).toEqual({ kind: 'array', n: 2 });
    const loaded = await store.getFollow(FOLLOW_A);
    expect(loaded?.envelope.permittedMarkets).toEqual(['BTC-USDT', 'ETH-USDT']);
    // The upsert path rewrites the column too; it must stay an array.
    await store.saveFollow({ ...base, envelope: { ...base.envelope, permittedMarkets: ['SOL-USDT'] } });
    expect((await store.getFollow(FOLLOW_A))?.envelope.permittedMarkets).toEqual(['SOL-USDT']);
  });

  it('INSERT unique fill_id is visible before run() — crash window cannot miss the row', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    const once = await store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
      const rows = await db!.sql<Array<{ follow_id: string; settled: boolean }>>`
          SELECT follow_id, settled FROM copy_settled_fee_shares WHERE fill_id = ${FILL} LIMIT 1
        `;
      expect(rows[0]?.follow_id).toBe(FOLLOW_A);
      expect(rows[0]?.settled).toBe(false);
      return share(FOLLOW_A, FILL, LEADER);
    });
    expect(once.status).toBe('claimed');
    expect(once.record.settled).toBe(true);
    const done = await store.getSettledFeeShare(FOLLOW_A, FILL);
    expect(done?.leaderId).toBe(LEADER);
    expect(done?.cappedLeaderShare).toBe(parseAmount('0.5'));
  });

  it('crash-after-claim leftover unique fill_id refuses a second leader without run()', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    await store.saveFollow(follow(FOLLOW_B, LEADER_B));
    // Process died after unique INSERT, before ledger post / UPDATE.
    await db!.sql`
        INSERT INTO copy_settled_fee_shares (
          follow_id, fill_id, leader_id, follower_id, asset_id,
          protocol_fee, applied_share_bps, gross_leader_share, capped_leader_share,
          skipped_reason, settled, created_at
        ) VALUES (
          ${FOLLOW_A}, ${FILL}, ${LEADER}, ${FOLLOWER}, '',
          0, 0, 0, 0, NULL, false, now()
        )
      `;

    let ran = false;
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_B, FILL, async () => {
        ran = true;
        return share(FOLLOW_B, FILL, LEADER_B);
      }),
    ).rejects.toMatchObject({ name: 'CopyError', code: 'trade.copy_settle_refused' });
    expect(ran).toBe(false);

    const rows = await db!.sql<Array<{ follow_id: string }>>`
        SELECT follow_id FROM copy_settled_fee_shares WHERE fill_id = ${FILL}
      `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.follow_id).toBe(FOLLOW_A);
  });

  it('failed run (pre-follow) deletes the claim — another follow can still settle', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    await store.saveFollow(follow(FOLLOW_B, LEADER_B));
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
        throw new CopyError('Fill predates this follow — refuse fee-share', 'trade.copy_settle_refused');
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_settle_refused' });

    const leftover = await db!.sql<Array<{ fill_id: string }>>`
        SELECT fill_id FROM copy_settled_fee_shares WHERE fill_id = ${FILL}
      `;
    expect(leftover).toHaveLength(0);

    const later = await store.runFeeShareSettleOnce(FOLLOW_B, FILL, async () => share(FOLLOW_B, FILL, LEADER_B));
    expect(later.status).toBe('claimed');
    expect(later.record.leaderId).toBe(LEADER_B);
  });

  it('pending leftover same-follow retries run(); other follow ran===false', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    await store.saveFollow(follow(FOLLOW_B, LEADER_B));
    await db!.sql`
        INSERT INTO copy_settled_fee_shares (
          follow_id, fill_id, leader_id, follower_id, asset_id,
          protocol_fee, applied_share_bps, gross_leader_share, capped_leader_share,
          skipped_reason, settled, created_at
        ) VALUES (
          ${FOLLOW_A}, ${FILL}, ${LEADER}, ${FOLLOWER}, '',
          0, 0, 0, 0, NULL, false, now()
        )
      `;

    let ranB = false;
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_B, FILL, async () => {
        ranB = true;
        return share(FOLLOW_B, FILL, LEADER_B);
      }),
    ).rejects.toMatchObject({ name: 'CopyError', code: 'trade.copy_settle_refused' });
    expect(ranB).toBe(false);

    let runsA = 0;
    const retry = await store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
      runsA += 1;
      return share(FOLLOW_A, FILL, LEADER);
    });
    expect(runsA).toBe(1);
    expect(retry.status).toBe('claimed');
    expect(retry.record.settled).toBe(true);
    expect(retry.record.leaderId).toBe(LEADER);
    const done = await store.getSettledFeeShare(FOLLOW_A, FILL);
    expect(done?.settled).toBe(true);
    expect(done?.cappedLeaderShare).toBe(parseAmount('0.5'));
  });

  it('killed refuse deletes the claim — another follow can still settle', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    await store.saveFollow(follow(FOLLOW_B, LEADER_B));
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
        throw new CopyError('Fee-share killed for this leader/follow — refuse payout', 'trade.copy_fee_share_killed');
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_fee_share_killed' });

    const leftover = await db!.sql<Array<{ fill_id: string }>>`
        SELECT fill_id FROM copy_settled_fee_shares WHERE fill_id = ${FILL}
      `;
    expect(leftover).toHaveLength(0);

    const later = await store.runFeeShareSettleOnce(FOLLOW_B, FILL, async () => share(FOLLOW_B, FILL, LEADER_B));
    expect(later.status).toBe('claimed');
    expect(later.record.leaderId).toBe(LEADER_B);
  });

  it('post-then-throw keeps unique fill_id — second leader does not run', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    await store.saveFollow(follow(FOLLOW_B, LEADER_B));
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
        throw new Error('payout threw after sweep');
      }),
    ).rejects.toThrow(/payout threw after sweep/);

    const leftover = await db!.sql<Array<{ follow_id: string }>>`
        SELECT follow_id FROM copy_settled_fee_shares WHERE fill_id = ${FILL}
      `;
    expect(leftover).toHaveLength(1);
    expect(leftover[0]?.follow_id).toBe(FOLLOW_A);

    let ran = false;
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_B, FILL, async () => {
        ran = true;
        return share(FOLLOW_B, FILL, LEADER_B);
      }),
    ).rejects.toMatchObject({ name: 'CopyError', code: 'trade.copy_settle_refused' });
    expect(ran).toBe(false);
  });

  it('leftover pending + CopyError on retry keeps the row — other follow ran===false', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    await store.saveFollow(follow(FOLLOW_B, LEADER_B));
    await db!.sql`
        INSERT INTO copy_settled_fee_shares (
          follow_id, fill_id, leader_id, follower_id, asset_id,
          protocol_fee, applied_share_bps, gross_leader_share, capped_leader_share,
          skipped_reason, settled, created_at
        ) VALUES (
          ${FOLLOW_A}, ${FILL}, ${LEADER}, ${FOLLOWER}, '',
          0, 0, 0, 0, NULL, false, now()
        )
      `;

    let seenInserted: boolean | undefined;
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_A, FILL, async (ctx) => {
        seenInserted = ctx.insertedThisCall;
        throw new CopyError('Fee-share killed for this leader/follow — refuse payout', 'trade.copy_fee_share_killed');
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_fee_share_killed' });
    expect(seenInserted).toBe(false);

    const leftover = await db!.sql<Array<{ follow_id: string }>>`
        SELECT follow_id FROM copy_settled_fee_shares WHERE fill_id = ${FILL}
      `;
    expect(leftover).toHaveLength(1);
    expect(leftover[0]?.follow_id).toBe(FOLLOW_A);

    let ranB = false;
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_B, FILL, async () => {
        ranB = true;
        return share(FOLLOW_B, FILL, LEADER_B);
      }),
    ).rejects.toMatchObject({ name: 'CopyError', code: 'trade.copy_settle_refused' });
    expect(ranB).toBe(false);
  });

  it('savePendingFeeShareReserve throws on 0-row UPDATE, not no-op', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    await expect(store.savePendingFeeShareReserve(FOLLOW_A, FILL, parseAmount('0.5'))).rejects.toMatchObject({
      name: 'CopyError',
      code: 'trade.copy_settle_refused',
    });

    await expect(
      store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
        throw new Error('crash after INSERT');
      }),
    ).rejects.toThrow(/crash after INSERT/);
    await store.savePendingFeeShareReserve(FOLLOW_A, FILL, parseAmount('0.5'));
    const stamped = await store.getSettledFeeShare(FOLLOW_A, FILL);
    expect(stamped?.cappedLeaderShare).toBe(parseAmount('0.5'));
    expect(stamped?.skippedReason).toBeNull();
    expect(stamped?.settled).toBe(false);
  });

  it('reserveAndStampPendingFeeShare 0-row rolls back earningsPaid', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    const key = `${LEADER}:${FOLLOWER}`;
    await expect(store.reserveAndStampPendingFeeShare(key, parseAmount('0.5'), parseAmount('100'), FOLLOW_A, FILL)).rejects.toMatchObject({
      name: 'CopyError',
      code: 'trade.copy_settle_refused',
    });
    expect((await store.getPeriodStats(key)).earningsPaid).toBe(0n);

    await expect(
      store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
        throw new Error('crash after INSERT');
      }),
    ).rejects.toThrow(/crash after INSERT/);
    const reserved = await store.reserveAndStampPendingFeeShare(key, parseAmount('0.5'), parseAmount('100'), FOLLOW_A, FILL);
    expect(reserved.reserved).toBe(parseAmount('0.5'));
    const stamped = await store.getSettledFeeShare(FOLLOW_A, FILL);
    expect(stamped?.cappedLeaderShare).toBe(parseAmount('0.5'));
    expect((await store.getPeriodStats(key)).earningsPaid).toBe(parseAmount('0.5'));
  });

  it('runFollowExclusive + reserveAndStampPendingFeeShare stamps pending and bumps earningsPaid', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    const key = `${LEADER}:${FOLLOWER}`;
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
        throw new Error('crash after INSERT');
      }),
    ).rejects.toThrow(/crash after INSERT/);

    await store.runFollowExclusive(FOLLOW_A, async (locked) => {
      const reserved = await locked.reserveAndStampPendingFeeShare(key, parseAmount('0.5'), parseAmount('100'), FOLLOW_A, FILL);
      expect(reserved.reserved).toBe(parseAmount('0.5'));
    });

    const stamped = await store.getSettledFeeShare(FOLLOW_A, FILL);
    expect(stamped?.cappedLeaderShare).toBe(parseAmount('0.5'));
    expect(stamped?.settled).toBe(false);
    expect(stamped?.skippedReason).toBeNull();
    expect((await store.getPeriodStats(key)).earningsPaid).toBe(parseAmount('0.5'));
  });

  it('exclusive leftover stamp-0 after committed reserve does not bump earningsPaid again', async () => {
    const store = new SqlCopyFollowStore(db!.sql);
    await store.saveFollow(follow(FOLLOW_A, LEADER));
    const key = `${LEADER}:${FOLLOWER}`;
    await expect(
      store.runFeeShareSettleOnce(FOLLOW_A, FILL, async () => {
        throw new Error('crash after INSERT');
      }),
    ).rejects.toThrow(/crash after INSERT/);

    await store.runFollowExclusive(FOLLOW_A, async (locked) => {
      const reserved = await locked.reserveAndStampPendingFeeShare(key, parseAmount('0.5'), parseAmount('100'), FOLLOW_A, FILL);
      expect(reserved.reserved).toBe(parseAmount('0.5'));
    });
    expect((await store.getSettledFeeShare(FOLLOW_A, FILL))?.cappedLeaderShare).toBe(parseAmount('0.5'));
    expect((await store.getPeriodStats(key)).earningsPaid).toBe(parseAmount('0.5'));

    await store.runFollowExclusive(FOLLOW_A, async (locked) => {
      const again = await locked.reserveAndStampPendingFeeShare(key, parseAmount('0.5'), parseAmount('100'), FOLLOW_A, FILL);
      expect(again.reserved).toBe(parseAmount('0.5'));
    });
    expect((await store.getPeriodStats(key)).earningsPaid).toBe(parseAmount('0.5'));
    expect((await store.getPeriodStats(key)).roundTrips).toBe(1);
    expect((await store.getSettledFeeShare(FOLLOW_A, FILL))?.cappedLeaderShare).toBe(parseAmount('0.5'));
  });

  describe('place-mirror once-key', () => {
    it('runPlaceMirrorOnce persists (follow, fill) and returns duplicate without re-running', async () => {
      const store = new SqlCopyFollowStore(db!.sql);
      await store.saveFollow(follow(FOLLOW_A, LEADER));
      let runs = 0;
      const first = await store.runPlaceMirrorOnce(FOLLOW_A, PLACE_FILL, async () => {
        runs += 1;
        return placedMirror(FOLLOW_A, PLACE_FILL);
      });
      expect(first.status).toBe('claimed');
      expect(runs).toBe(1);

      const second = await store.runPlaceMirrorOnce(FOLLOW_A, PLACE_FILL, async () => {
        runs += 1;
        return placedMirror(FOLLOW_A, PLACE_FILL);
      });
      expect(second.status).toBe('duplicate');
      expect(second.record.orderId).toBe('order-sql-place-1');
      expect(runs).toBe(1);

      const saved = await store.getPlacedMirror(FOLLOW_A, PLACE_FILL);
      expect(saved?.clientOrderId).toBe('client-order-sql-1');
    });

    it('INSERT after run() leaves durable row for redelivery', async () => {
      const store = new SqlCopyFollowStore(db!.sql);
      await store.saveFollow(follow(FOLLOW_A, LEADER));
      await store.runPlaceMirrorOnce(FOLLOW_A, PLACE_FILL, async () => placedMirror(FOLLOW_A, PLACE_FILL));
      const rows = await db!.sql<Array<{ order_id: string }>>`
        SELECT order_id FROM copy_placed_mirrors WHERE follow_id = ${FOLLOW_A} AND fill_id = ${PLACE_FILL}
      `;
      expect(rows[0]?.order_id).toBe('order-sql-place-1');
      expect((await store.getPlacedMirror(FOLLOW_A, PLACE_FILL))?.price).toBe(parseAmount('5000'));
    });
  });
});
