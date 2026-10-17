import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus, MemorySeenStore } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from './fixture-truncate.testkit.js';
import { RankService } from './rank/rank-service.js';
import { subscribeXpEvents } from './events.js';

/**
 * xpEarned → rank_state. THE CONSUMER THAT DID NOT EXIST.
 *
 * svc-p2p and svc-trade have published this subject since they shipped, both
 * naming svc-identity in their own comments as the way into `rank_state`, and
 * nothing subscribed. XP earned by trading or by completing a P2P trade was
 * retained by JetStream and read by nobody — so every rank shown to those users
 * was wrong by exactly the amount they had earned. These tests are the proof it
 * now lands, and that a redelivery does not pay it twice.
 *
 * Real Postgres, because the claim under test is a row in `xp_events` and a
 * `rank_state` upsert under a unique index — none of which a fake can certify.
 * Producer names on `MemoryEventBus` are the real ones, so the envelope this
 * consumer sees is shaped exactly as svc-p2p's and svc-trade's are.
 */

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('xpEarned consumer (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_xp',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });

  async function seedUser(userId: string) {
    await db.sql`
      INSERT INTO users (id, handle, email, password_hash, status)
      VALUES (${userId}, ${`xp_${userId.slice(0, 8)}`}, ${`xp-${userId.slice(0, 8)}@test.local`}, 'x', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async function xpOf(userId: string): Promise<bigint | null> {
    const rows = await db.sql<Array<{ xp: string }>>`SELECT xp FROM rank_state WHERE user_id = ${userId}`;
    return rows.length === 0 ? null : BigInt(rows[0]!.xp);
  }

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('xpEarned consumer', () => {
    async function wire(producer: string) {
      const bus = new MemoryEventBus(producer);
      const rank = new RankService(db.sql, bus);
      await rank.seedTiers();
      await subscribeXpEvents(bus, rank, new MemorySeenStore());
      return bus;
    }

    it("lands a P2P award in rank_state — the module's XP now reaches the graph", async () => {
      const userId = randomUUID();
      await seedUser(userId);
      const bus = await wire('svc-p2p');
      const tradeId = randomUUID();

      await bus.publish(
        'xpEarned',
        { userId, sourceModule: 'p2p', action: 'trade.completed.seller', xpDelta: 30, meta: { tradeId } },
        { idempotencyKey: `p2p:trade.completed.seller:${tradeId}:${userId}` },
      );

      expect(await xpOf(userId)).toBe(30n);
    });

    it('lands a trade award too — both producers reach the same graph', async () => {
      const userId = randomUUID();
      await seedUser(userId);
      const bus = await wire('svc-trade');
      const orderId = randomUUID();

      await bus.publish(
        'xpEarned',
        { userId, sourceModule: 'trade', action: 'order.filled', xpDelta: 10, meta: { orderId, marketId: 'BTC-USDT' } },
        { idempotencyKey: `trade.order.xp:${orderId}` },
      );

      expect(await xpOf(userId)).toBe(10n);
    });

    /**
     * THE HANDSHAKE, PROVED. The producers' business key is written to
     * `xp_events.idempotency_key` untranslated — that shape is why the catalog
     * called this "a handshake with a consumer that does not exist", and it is
     * what makes the unique index the durable dedupe rather than a coincidence.
     */
    it("writes the producer's own key into xp_events, untranslated", async () => {
      const userId = randomUUID();
      await seedUser(userId);
      const bus = await wire('svc-p2p');
      const tradeId = randomUUID();
      const key = `p2p:trade.completed.buyer:${tradeId}:${userId}`;

      await bus.publish(
        'xpEarned',
        { userId, sourceModule: 'p2p', action: 'trade.completed.buyer', xpDelta: 20, meta: { tradeId } },
        { idempotencyKey: key },
      );

      const rows = await db.sql<Array<{ idempotency_key: string; source_module: string; action: string; xp_delta: string }>>`
        SELECT idempotency_key, source_module, action, xp_delta FROM xp_events WHERE user_id = ${userId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.idempotency_key).toBe(key);
      expect(rows[0]!.source_module).toBe('p2p');
      expect(rows[0]!.action).toBe('trade.completed.buyer');
      expect(rows[0]!.xp_delta).toBe('20');
    });

    /**
     * At-least-once delivery is the bus's contract, so paying twice has to be
     * impossible at the database rather than merely unlikely in process. The
     * `idempotent()` wrapper is a pre-filter; this asserts the guarantee behind
     * it by publishing the same key twice on the same bus.
     */
    it('does not pay a redelivered award twice', async () => {
      const userId = randomUUID();
      await seedUser(userId);
      const bus = await wire('svc-trade');
      const orderId = randomUUID();
      const award = [
        'xpEarned',
        { userId, sourceModule: 'trade', action: 'order.filled', xpDelta: 10, meta: { orderId } },
        { idempotencyKey: `trade.order.xp:${orderId}` },
      ] as const;

      await bus.publish(...award);
      await bus.publish(...award);

      expect(await xpOf(userId)).toBe(10n);
      expect(await db.sql`SELECT id FROM xp_events WHERE user_id = ${userId}`).toHaveLength(1);
    });

    it('accumulates distinct awards across both modules', async () => {
      const userId = randomUUID();
      await seedUser(userId);
      const bus = await wire('svc-p2p');
      const tradeId = randomUUID();
      const orderId = randomUUID();

      await bus.publish(
        'xpEarned',
        { userId, sourceModule: 'p2p', action: 'trade.completed.seller', xpDelta: 30, meta: { tradeId } },
        { idempotencyKey: `p2p:trade.completed.seller:${tradeId}:${userId}` },
      );
      await bus.publish(
        'xpEarned',
        { userId, sourceModule: 'trade', action: 'order.filled', xpDelta: 10, meta: { orderId } },
        { idempotencyKey: `trade.order.xp:${orderId}` },
      );

      expect(await xpOf(userId)).toBe(40n);
    });

    /**
     * svc-p2p awards `dispute.lost: -100`. A negative delta must not drive
     * `rank_state.xp` below zero — there is a check constraint on it, and a
     * violation here would take down the whole award rather than floor it.
     */
    it('floors at zero on a negative award rather than violating the check constraint', async () => {
      const userId = randomUUID();
      await seedUser(userId);
      const bus = await wire('svc-p2p');
      const tradeId = randomUUID();

      await bus.publish(
        'xpEarned',
        { userId, sourceModule: 'p2p', action: 'dispute.lost', xpDelta: -100, meta: { tradeId } },
        { idempotencyKey: `p2p:dispute.lost:${tradeId}:${userId}` },
      );

      expect(await xpOf(userId)).toBe(0n);
    });

    /**
     * An award for a user identity has never heard of is a producer bug or a
     * deleted account, and both need a human. The handler lets it throw so the
     * bus NAKs and the message parks. Swallowing it would make XP silently
     * vanish — which is the exact failure this consumer exists to end, moved
     * one step later and made harder to find.
     */
    it('refuses an award for a user it does not have, rather than swallowing it', async () => {
      const bus = await wire('svc-p2p');
      const unknown = randomUUID();
      const tradeId = randomUUID();

      await expect(
        bus.publish(
          'xpEarned',
          { userId: unknown, sourceModule: 'p2p', action: 'trade.completed.seller', xpDelta: 30, meta: { tradeId } },
          { idempotencyKey: `p2p:trade.completed.seller:${tradeId}:${unknown}` },
        ),
      ).rejects.toThrow();

      expect(await xpOf(unknown)).toBeNull();
    });
  });
}
