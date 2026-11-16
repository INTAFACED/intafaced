import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from '../auth/auth-service.js';
import type { FactorActor } from '../auth/factor-gate.js';
import { requestMetaAls } from '../auth/request-meta.js';
import { RankService } from '../rank/rank-service.js';
import {
  clearExtraControls,
  extraControlsFor,
  parseExtraControlsMin,
  readSafety,
  recordSignInSignal,
  setExtraControls,
  setLocationConsent,
} from './safety.js';

// BK-safe-01, J-bank-18 #4: step-up extras with the owner's least number of checks, and the location signal kept only
// under the person's consent.

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = testDatabaseUrl();
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-safety-pg-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

describe('IDENTITY_EXTRA_CONTROLS_MIN', () => {
  it('is blank (not published) or a whole number 1 to 4', () => {
    expect(parseExtraControlsMin(undefined)).toBeNull();
    expect(parseExtraControlsMin('  ')).toBeNull();
    expect(parseExtraControlsMin('2')).toBe(2);
    for (const bad of ['0', '5', '1.5', 'two']) expect(() => parseExtraControlsMin(bad)).toThrow(/IDENTITY_EXTRA_CONTROLS_MIN/);
  });
});

const available = await postgresAvailable(TEST_URL);

if (!available) {
  describe.skip('step-up extras and location signal (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  let n = 0;
  const PASSWORD = 'correct horse battery staple';
  const person = async () => {
    const handle = `sf${process.pid}${++n}`;
    const tokens = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    return { ...tokens, handle };
  };
  const me: FactorActor = { delegated: false, privileged: false, mfa: false };
  const allowance = { amount: '500', assetId: 'USDT' as const };

  afterAll(async () => {
    await db.drop();
  });

  describe('step-up extras (BK-safe-01)', () => {
    it('refuses while the owner number is blank, refuses fewer checks than it, and keeps two', async () => {
      const u = await person();
      await expect(
        setExtraControls(db.sql, { userId: u.userId, minimum: null, controls: ['trusted_contacts', 'secret_qr'], allowance }),
      ).rejects.toMatchObject({ code: 'identity.extra_controls_unset' });
      await expect(
        setExtraControls(db.sql, { userId: u.userId, minimum: 2, controls: ['trusted_contacts'], allowance }),
      ).rejects.toMatchObject({ code: 'identity.extra_controls_too_few' });
      // The same check twice is one check.
      await expect(
        setExtraControls(db.sql, { userId: u.userId, minimum: 2, controls: ['secret_qr', 'secret_qr'], allowance }),
      ).rejects.toMatchObject({ code: 'identity.extra_controls_too_few' });
      expect(await extraControlsFor(db.sql, u.userId)).toEqual({ userId: u.userId, controls: [], allowance: null });

      const set = await setExtraControls(db.sql, {
        userId: u.userId,
        minimum: 2,
        controls: ['trusted_contacts', 'secret_qr'],
        allowance: { amount: '500.50', assetId: 'USDT' },
      });
      expect(set.changed).toBe(true);
      expect(await extraControlsFor(db.sql, u.userId)).toEqual({
        userId: u.userId,
        controls: ['secret_qr', 'trusted_contacts'],
        allowance: { amount: '500.5', assetId: 'USDT' },
      });
      // The same extras again change nothing.
      const again = await setExtraControls(db.sql, {
        userId: u.userId,
        minimum: 2,
        controls: ['secret_qr', 'trusted_contacts'],
        allowance: { amount: '500.5', assetId: 'USDT' },
      });
      expect(again.changed).toBe(false);
      expect((await readSafety(db.sql, u.userId, 2)).extraControls).toMatchObject({ minimum: 2, allowance: { amount: '500.5' } });

      expect(await clearExtraControls(db.sql, u.userId)).toEqual({ changed: true });
      expect(await clearExtraControls(db.sql, u.userId)).toEqual({ changed: false });
      expect((await extraControlsFor(db.sql, u.userId)).allowance).toBeNull();
    });

    it('known locations needs the location consent; turning the consent off takes it out of the extras', async () => {
      const u = await person();
      await expect(
        setExtraControls(db.sql, { userId: u.userId, minimum: 2, controls: ['known_locations', 'secret_qr'], allowance }),
      ).rejects.toMatchObject({ code: 'identity.location_consent_required' });
      await setLocationConsent(db.sql, u.userId, true);
      await setExtraControls(db.sql, { userId: u.userId, minimum: 2, controls: ['known_locations', 'secret_qr'], allowance });
      await setLocationConsent(db.sql, u.userId, false);
      expect((await extraControlsFor(db.sql, u.userId)).controls).toEqual(['secret_qr']);
    });

    it('a change takes the person’s own password, and an API key or sub-account is refused', async () => {
      const u = await person();
      await expect(auth.confirmOwnPassword({ userId: u.userId, actor: me, password: 'wrong password here' })).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
      await expect(auth.confirmOwnPassword({ userId: u.userId, actor: me, password: PASSWORD })).resolves.toBeUndefined();
      await expect(
        auth.confirmOwnPassword({ userId: u.userId, actor: { ...me, delegated: true }, password: PASSWORD }),
      ).rejects.toMatchObject({ code: 'auth.mfa_required' });
    });
  });

  describe('location signal (BK-safe-01)', () => {
    it('keeps a sign-in region only under the consent, records each change once, and deletes the regions when it is off', async () => {
      const u = await person();
      const signIn = (region: string) => requestMetaAls.run({ region }, () => auth.login({ identifier: u.handle, password: PASSWORD }));

      await signIn('AA');
      expect((await readSafety(db.sql, u.userId, null)).location).toEqual({ consent: false, changedAt: null, signals: [] });
      expect(await db.sql`SELECT id FROM sign_in_location_signals WHERE user_id = ${u.userId}`).toHaveLength(0);
      // Refusing a consent never given records nothing.
      expect(await setLocationConsent(db.sql, u.userId, false)).toEqual({ changed: false });

      expect(await setLocationConsent(db.sql, u.userId, true)).toEqual({ changed: true });
      expect(await setLocationConsent(db.sql, u.userId, true)).toEqual({ changed: false });
      await signIn('AA');
      await signIn('XX'); // the edge could not tell: nothing is kept
      const on = (await readSafety(db.sql, u.userId, null)).location;
      expect(on.consent).toBe(true);
      expect(on.changedAt).not.toBeNull();
      expect(on.signals.map((s) => s.region)).toEqual(['AA']);

      expect(await setLocationConsent(db.sql, u.userId, false)).toEqual({ changed: true });
      expect(await db.sql`SELECT id FROM sign_in_location_signals WHERE user_id = ${u.userId}`).toHaveLength(0);
      await signIn('AA');
      expect((await readSafety(db.sql, u.userId, null)).location.signals).toEqual([]);
      expect(await db.sql`SELECT consent FROM location_consent_events WHERE user_id = ${u.userId} ORDER BY changed_at`).toEqual([
        { consent: true },
        { consent: false },
      ]);
    });

    it('a signal that cannot be kept never fails the sign-in', async () => {
      const u = await person();
      const warned: string[] = [];
      // A database that refuses every query (only its rejection is used).
      const broken = (() => Promise.reject(new Error('down'))) as unknown as typeof db.sql; // oxlint-disable-line garden/no-double-cast -- a stand-in database that only rejects
      expect(await recordSignInSignal(broken, { userId: u.userId, sessionId: u.userId, region: 'AA' }, (_d, msg) => warned.push(msg))).toBe(
        false,
      );
      expect(warned).toEqual(['identity.location_signal_not_kept']);
    });
  });
}
