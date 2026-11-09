import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { SecurityLock } from './security-lock.js';
import { linkedWallets } from './linked-wallets.js';

/** The linked-wallet read against real rows: the account's own wallets in link order, its status and its security lock. TEST values only. */

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
  secret: 'an-identity-linked-wallets-pg-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
// TEST addresses, made up for this file; they hold nothing.
const FIRST = `0x${'a1'.repeat(20)}`;
const SECOND = `0x${'B2'.repeat(20)}`;
const THEIRS = `0x${'c3'.repeat(20)}`;

if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('linked wallets (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_linked_wallets',
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
  let n = 0;
  const person = async () => {
    const handle = `lw${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  };
  const link = (userId: string, address: string, at: string) =>
    db.sql`INSERT INTO wallet_identities (address, user_id, created_at) VALUES (${address.toLowerCase()}, ${userId}, ${at}::timestamptz)`;

  describe('linked wallets', () => {
    it("lists the account's own wallets only, lower-case, oldest link first", async () => {
      const me = await person();
      const other = await person();
      expect(await linkedWallets(db.sql, me)).toEqual({ state: 'usable', wallets: [] });
      await link(me, SECOND, '2026-11-08T20:00:02Z');
      await link(me, FIRST, '2026-11-08T20:00:01Z');
      await link(other, THEIRS, '2026-11-08T20:00:00Z');
      expect(await linkedWallets(db.sql, me)).toEqual({
        state: 'usable',
        wallets: [
          { address: FIRST, linkedAt: '2026-11-08T20:00:01.000Z' },
          { address: SECOND.toLowerCase(), linkedAt: '2026-11-08T20:00:02.000Z' },
        ],
      });
    });

    it('answers account_inactive for a frozen account, one under a security lock, or none at all', async () => {
      const frozen = await person();
      await link(frozen, `0x${'d4'.repeat(20)}`, '2026-11-08T20:00:00Z');
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen}`;
      expect(await linkedWallets(db.sql, frozen)).toEqual({ state: 'account_inactive' });

      const locked = await person();
      await link(locked, `0x${'e5'.repeat(20)}`, '2026-11-08T20:00:00Z');
      await new SecurityLock(db.sql, 3600).lock(locked, { kind: 'self', userId: locked });
      expect(await linkedWallets(db.sql, locked)).toEqual({ state: 'account_inactive' });
      expect(await linkedWallets(db.sql, '99999999-9999-4999-8999-999999999999')).toEqual({ state: 'account_inactive' });
    });
  });
}
