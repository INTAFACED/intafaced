/**
 * Sub-account feature switches against Postgres: session only, refuse while the owner eligibility is blank, offered
 * features per kind, futures refused, idempotent on and off.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';
import { AuthService } from '../auth/auth-service.js';
import { SubAccountFeatureService, parseFeatureEligibility } from './sub-account-features.js';

function identityTestUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const parsed = new URL(raw);
  if (!parsed.pathname.endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

const DATABASE_URL = identityTestUrl();
const PASSWORD = 'correct horse battery staple';
const tokenConfig = {
  secret: 'an-identity-sub-account-features-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const webauthnConfig = { rpID: 'localhost', rpName: 'INTAFACED', origin: 'http://localhost:3000' };
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

describe('parseFeatureEligibility', () => {
  it('reads kinds and features, and publishes nothing for blank or unknown input', () => {
    expect(parseFeatureEligibility('standard:spot+convert,spot:spot')?.get('standard')).toEqual(new Set(['spot', 'convert']));
    expect(parseFeatureEligibility('spot:spot')?.get('spot')).toEqual(new Set(['spot']));
    expect(parseFeatureEligibility(undefined)).toBeUndefined();
    expect(parseFeatureEligibility('  ')).toBeUndefined();
    expect(parseFeatureEligibility('standard:spot+margin')).toBeUndefined();
    expect(parseFeatureEligibility('vip:spot')).toBeUndefined();
    expect(parseFeatureEligibility('standard')).toBeUndefined();
    expect(parseFeatureEligibility('standard:spot,vip:spot')).toBeUndefined();
  });
});

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('sub-account features (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: DATABASE_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(
    db.sql,
    bus,
    rank,
    tokenConfig,
    webauthnConfig,
    randomBytes(32).toString('base64'),
    undefined,
    undefined,
    25,
    undefined,
    undefined,
    ['managed'],
  );
  const published = new SubAccountFeatureService({
    sql: db.sql,
    eligibility: parseFeatureEligibility('standard:spot+convert+futures,managed:spot'),
  });
  const blank = new SubAccountFeatureService({ sql: db.sql, eligibility: undefined });

  let n = 0;
  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function setup(kind: 'standard' | 'managed' = 'standard') {
    const handle = `sf${process.pid}x${++n}`;
    const user = await auth.register({ handle, email: `${handle}@example.com`, password: PASSWORD, region: 'DE' });
    const { id } = await auth.createSubAccount(user.userId, 'desk', undefined, { kind });
    return { actor: { userId: user.userId, apiKey: false, subAccount: false }, id };
  }
  const code = async (run: Promise<unknown>) => {
    try {
      await run;
    } catch (err) {
      return (err as { code?: string }).code;
    }
    throw new Error('expected a refusal');
  };

  it('turns a feature on once, reads it back, and turns it off once', async () => {
    const { actor, id } = await setup();
    expect(await published.set({ ...actor, subAccountId: id, feature: 'spot', enabled: true })).toEqual({
      feature: 'spot',
      enabled: true,
      changed: true,
    });
    expect((await published.set({ ...actor, subAccountId: id, feature: 'spot', enabled: true })).changed).toBe(false);
    const read = await published.get({ ...actor, subAccountId: id });
    expect(read.published).toBe(true);
    expect(read.features.find((f) => f.feature === 'spot')).toEqual({ feature: 'spot', offered: true, enabled: true });
    expect(read.features.find((f) => f.feature === 'algo')).toEqual({ feature: 'algo', offered: false, enabled: false });
    expect(read.features.find((f) => f.feature === 'futures')?.offered).toBe(false);
    expect((await published.set({ ...actor, subAccountId: id, feature: 'spot', enabled: false })).changed).toBe(true);
    expect((await published.set({ ...actor, subAccountId: id, feature: 'spot', enabled: false })).changed).toBe(false);
  });

  it('refuses a feature the kind is not offered, futures, and enabling while the owner setting is blank', async () => {
    const managed = await setup('managed');
    expect(await code(published.set({ ...managed.actor, subAccountId: managed.id, feature: 'convert', enabled: true }))).toBe(
      'identity.sub_account_feature_not_offered',
    );
    const std = await setup();
    expect(await code(published.set({ ...std.actor, subAccountId: std.id, feature: 'futures', enabled: true }))).toBe(
      'identity.sub_account_feature_unavailable',
    );
    expect(await code(blank.set({ ...std.actor, subAccountId: std.id, feature: 'spot', enabled: true }))).toBe(
      'identity.sub_account_features_unset',
    );
    expect((await blank.get({ ...std.actor, subAccountId: std.id })).published).toBe(false);
    // Turning off is still allowed with no setting published.
    await published.set({ ...std.actor, subAccountId: std.id, feature: 'spot', enabled: true });
    expect((await blank.set({ ...std.actor, subAccountId: std.id, feature: 'spot', enabled: false })).changed).toBe(true);
  });

  it('refuses a frozen, revoked or someone else’s sub-account, and any key or sub-account caller', async () => {
    const { actor, id } = await setup();
    const other = await setup();
    expect(await code(published.get({ ...other.actor, subAccountId: id }))).toBe('identity.sub_account_not_found');
    expect(await code(published.set({ ...actor, subAccountId: id, feature: 'spot', enabled: true, apiKey: true }))).toBe(
      'identity.sub_account_features_delegated',
    );
    expect(await code(published.get({ ...actor, subAccountId: id, subAccount: true }))).toBe('identity.sub_account_features_delegated');
    await db.sql`UPDATE sub_accounts SET frozen = 1 WHERE id = ${id}`;
    expect(await code(published.set({ ...actor, subAccountId: id, feature: 'spot', enabled: true }))).toBe('identity.sub_account_frozen');
    await db.sql`UPDATE sub_accounts SET frozen = 0, revoked = true WHERE id = ${id}`;
    expect(await code(published.get({ ...actor, subAccountId: id }))).toBe('identity.sub_account_revoked');
  });
}
