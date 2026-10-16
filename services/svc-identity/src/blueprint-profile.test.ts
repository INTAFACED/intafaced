import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus, MemorySeenStore } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from './fixture-truncate.testkit.js';
import { applyBlueprintCreated, applyBlueprintDeleted, readBlueprintId } from './blueprint-profile.js';
import { subscribeBlueprintProfileEvents } from './events.js';

/**
 * Blueprint cascade — svc-identity half of §7.2.
 *
 * Real Postgres. Proves:
 *   · created sets profiles.blueprint_id
 *   · deleted clears only when the id still matches
 *   · a newer blueprint survives a late/redelivered delete of the old one
 *   · bus wiring delivers into the same mutations (MemoryEventBus)
 *
 * Isolation: per-run schema via `createTestDb` (same pattern as identity.test.ts
 * and svc-ledger). No TRUNCATE against the shared `identity` schema.
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
  describe.skip('blueprint profile cascade (§7.2) (Postgres unavailable — start docker compose)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_bp',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });

  async function seedUser(userId: string) {
    await db.sql`
      INSERT INTO users (id, handle, email, password_hash, status)
      VALUES (${userId}, ${`bp_${userId.slice(0, 8)}`}, ${`bp-${userId.slice(0, 8)}@test.local`}, 'x', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    await db.sql`
      INSERT INTO profiles (user_id, display_name, region)
      VALUES (${userId}, 'Cascade Test', 'global')
      ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name
    `;
    await db.sql`UPDATE profiles SET blueprint_id = NULL WHERE user_id = ${userId}`;
  }

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('blueprint profile cascade (§7.2)', () => {
    it('uses a unique schema so parallel suites cannot share state', () => {
      expect(db.schema).toMatch(/^test_identity_bp_\d+_\d+$/);
      expect(db.schema).not.toBe('identity');
    });

    it('sets blueprint_id on created', async () => {
      const userId = randomUUID();
      const blueprintId = randomUUID();
      await seedUser(userId);

      const r = await applyBlueprintCreated(db.sql, { userId, blueprintId });
      expect(r.updated).toBe(true);
      expect(await readBlueprintId(db.sql, userId)).toBe(blueprintId);
    });

    it('clears blueprint_id on deleted when it still matches', async () => {
      const userId = randomUUID();
      const blueprintId = randomUUID();
      await seedUser(userId);
      await applyBlueprintCreated(db.sql, { userId, blueprintId });

      const r = await applyBlueprintDeleted(db.sql, { userId, blueprintId });
      expect(r.cleared).toBe(true);
      expect(await readBlueprintId(db.sql, userId)).toBeNull();
    });

    it('does not clear a newer blueprint when an old delete is redelivered', async () => {
      const userId = randomUUID();
      const oldId = randomUUID();
      const newId = randomUUID();
      await seedUser(userId);
      await applyBlueprintCreated(db.sql, { userId, blueprintId: oldId });
      await applyBlueprintCreated(db.sql, { userId, blueprintId: newId });

      const r = await applyBlueprintDeleted(db.sql, { userId, blueprintId: oldId });
      expect(r.cleared).toBe(false);
      expect(await readBlueprintId(db.sql, userId)).toBe(newId);
    });

    it('is a no-op when already cleared (idempotent erase)', async () => {
      const userId = randomUUID();
      const blueprintId = randomUUID();
      await seedUser(userId);
      await applyBlueprintCreated(db.sql, { userId, blueprintId });
      await applyBlueprintDeleted(db.sql, { userId, blueprintId });

      const r = await applyBlueprintDeleted(db.sql, { userId, blueprintId });
      expect(r.cleared).toBe(false);
      expect(await readBlueprintId(db.sql, userId)).toBeNull();
    });

    it('bus subscribers apply create then delete end to end', async () => {
      const userId = randomUUID();
      const blueprintId = randomUUID();
      await seedUser(userId);

      const bus = new MemoryEventBus('svc-blueprint');
      const store = new MemorySeenStore();
      await subscribeBlueprintProfileEvents(bus, db.sql, store);

      await bus.publish(
        'blueprintCreated',
        {
          blueprintId,
          userId,
          engineVersion: 'test-1',
          visibility: 'private',
        },
        { idempotencyKey: `created:${blueprintId}` },
      );

      expect(await readBlueprintId(db.sql, userId)).toBe(blueprintId);

      await bus.publish(
        'blueprintDeleted',
        {
          blueprintId,
          userId,
          erasedAt: new Date().toISOString(),
        },
        { idempotencyKey: `deleted:${blueprintId}` },
      );

      expect(await readBlueprintId(db.sql, userId)).toBeNull();

      await bus.publish(
        'blueprintDeleted',
        {
          blueprintId,
          userId,
          erasedAt: new Date().toISOString(),
        },
        { idempotencyKey: `deleted:${blueprintId}:replay` },
      );
      expect(await readBlueprintId(db.sql, userId)).toBeNull();
    });
  });
}
