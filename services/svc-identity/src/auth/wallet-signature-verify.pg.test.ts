import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { SecurityLock } from './security-lock.js';
import { signingAccount, verifyWalletSignature } from './wallet-signature-verify.js';

/** The wallet-signature check against real rows: the account's own linked wallets, its status and its security lock. TEST values only. */

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
  secret: 'an-identity-wallet-signature-pg-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
// TEST keys, made up for this file; they hold nothing.
const MINE = privateKeyToAccount(`0x${'3'.repeat(64)}`);
const THEIRS = privateKeyToAccount(`0x${'4'.repeat(64)}`);
const FROZEN = privateKeyToAccount(`0x${'5'.repeat(64)}`);
const MESSAGE = 'TEST signed ballot';

if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('wallet signature check (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_wallet_signature',
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
    const handle = `ws${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  };
  const link = (userId: string, address: string) =>
    db.sql`INSERT INTO wallet_identities (address, user_id) VALUES (${address.toLowerCase()}, ${userId})`;
  const check = async (userId: string, signer = MINE) =>
    verifyWalletSignature((id) => signingAccount(db.sql, id), {
      userId,
      message: MESSAGE,
      signature: await signer.signMessage({ message: MESSAGE }),
    });

  describe('wallet signature check', () => {
    it("answers from the account's own wallets only", async () => {
      const me = await person();
      const other = await person();
      expect(await check(me)).toEqual({ state: 'no_wallet' });
      await link(me, MINE.address);
      await link(other, THEIRS.address);
      expect(await check(me)).toEqual({ state: 'linked', address: MINE.address.toLowerCase() });
      expect(await check(me, THEIRS)).toEqual({ state: 'not_linked' });
    });

    it('answers account_inactive for a frozen account or one under a security lock', async () => {
      const frozen = await person();
      await link(frozen, FROZEN.address);
      await db.sql`UPDATE users SET status = 'frozen' WHERE id = ${frozen}`;
      expect(await check(frozen, FROZEN)).toEqual({ state: 'account_inactive' });

      const locked = await person();
      await new SecurityLock(db.sql, 3600).lock(locked, { kind: 'self', userId: locked });
      expect(await check(locked)).toEqual({ state: 'account_inactive' });
      expect(await check('99999999-9999-4999-8999-999999999999')).toEqual({ state: 'account_inactive' });
    });
  });
}
