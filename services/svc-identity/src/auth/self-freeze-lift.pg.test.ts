import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import type { FactorActor } from './factor-gate.js';
import { RankService } from '../rank/rank-service.js';
import { SelfFreezeLift, type SelfFreezeLiftError } from './self-freeze-lift.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = testDatabaseUrl();
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-lift-pg-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('self-freeze lift (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_freeze_lift',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  afterAll(async () => {
    await db.drop();
  });
  const PASSWORD = 'correct horse battery staple';
  const me: FactorActor = { delegated: false, privileged: false, mfa: false };
  let n = 0;
  const frozenPerson = async () => {
    const handle = `lf${process.pid}${++n}`;
    const u = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    await auth.selfFreeze({ userId: u.userId, actor: me, reason: 'temporary', password: PASSWORD });
    return u.userId;
  };

  describe('self-freeze lift', () => {
    it('refuses before the owner wait has passed and keeps the freeze', async () => {
      const userId = await frozenPerson();
      const lift = new SelfFreezeLift(db.sql, 3600);
      await expect(lift.lift(userId)).rejects.toMatchObject({ code: 'identity.self_freeze_lift_too_soon' });
      expect(await auth.selfFreezeStatus(userId)).toMatchObject({ frozen: true });
    });

    it('lifts once the wait has passed, and a retry changes nothing', async () => {
      const userId = await frozenPerson();
      const lift = new SelfFreezeLift(db.sql, 0);
      const first = await lift.lift(userId);
      expect(first.changed).toBe(true);
      expect(first.liftedAt).toBeInstanceOf(Date);
      expect(await auth.selfFreezeStatus(userId)).toMatchObject({ frozen: false });
      expect(await lift.lift(userId)).toEqual({ frozen: false, changed: false, liftedAt: null });
      const rows = await db.sql<Array<{ state: string }>>`SELECT state FROM account_self_freezes WHERE user_id = ${userId}`;
      expect(rows.map((r) => r.state)).toEqual(['lifted']);
    });

    it('refuses while the wait is unset even with an open freeze', async () => {
      const userId = await frozenPerson();
      await expect(new SelfFreezeLift(db.sql, undefined).lift(userId)).rejects.toMatchObject({
        code: 'identity.self_freeze_lift_wait_unset',
      });
      expect(await auth.selfFreezeStatus(userId)).toMatchObject({ frozen: true });
    });

    it('logs auth.self_freeze_lifted once on a real lift, and not on a retry or a refusal', async () => {
      const userId = await frozenPerson();
      const warn = vi.fn();
      const soon = new SelfFreezeLift(db.sql, 3600);
      soon.useLogger({ warn });
      await expect(soon.lift(userId)).rejects.toMatchObject({ code: 'identity.self_freeze_lift_too_soon' });
      const lift = new SelfFreezeLift(db.sql, 0);
      lift.useLogger({ warn });
      const done = await lift.lift(userId);
      await lift.lift(userId);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({ userId, liftedAt: done.liftedAt!.toISOString() }, 'auth.self_freeze_lifted');
    });

    it('assertDue refuses too soon without writing, and passes once due or with nothing open', async () => {
      const userId = await frozenPerson();
      const soon = await new SelfFreezeLift(db.sql, 3600).assertDue(userId).catch((err: unknown) => err);
      expect(soon).toMatchObject({ code: 'identity.self_freeze_lift_too_soon' });
      // The seconds left come from the database clock that decided "too soon", not the app's.
      const left = (soon as SelfFreezeLiftError).secondsLeft!;
      expect(left).toBeGreaterThan(3500);
      expect(left).toBeLessThanOrEqual(3600);
      expect(await auth.selfFreezeStatus(userId)).toMatchObject({ frozen: true });
      await expect(new SelfFreezeLift(db.sql, 0).assertDue(userId)).resolves.toBeUndefined();
      expect(await auth.selfFreezeStatus(userId)).toMatchObject({ frozen: true });
      await expect(new SelfFreezeLift(db.sql, 3600).assertDue('00000000-0000-4000-8000-0000000000ff')).resolves.toBeUndefined();
    });
  });
}
