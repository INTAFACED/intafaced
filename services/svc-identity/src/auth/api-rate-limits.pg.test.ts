/**
 * API rate limits, identity's half (DV-limits-01 to 03, J-developer-06 #1 #5 #6): the owner's tiers parse or stop the
 * service and never default; a key's limit follows its tier and a grant; a request is recorded once and refused while
 * the tiers are blank; a review changes the request, the key's grant and exactly one audit row together, or nothing.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { AuthService } from './auth-service.js';
import {
  createLimitRequest,
  installApiKeyRateExchange,
  keyRateLimit,
  limitDesk,
  listMyLimitRequests,
  parseRatePolicy,
  publishedTiers,
  reviewLimitRequest,
  type RatePolicy,
} from './api-rate-limits.js';
import { hashToken } from './passwords.js';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { RankService } from '../rank/rank-service.js';

// TEST values only: a base tier of 60 refilling 1,200 a minute, a sandbox tier of 30 and 600, a ceiling of 6,000.
const RAW = JSON.stringify({
  tiers: [
    { id: 'base', burst: 60, refillPerMinute: 1200 },
    { id: 'sandbox', burst: 30, refillPerMinute: 600 },
  ],
  grantCeilingPerMinute: 6000,
});
const POLICY = parseRatePolicy(RAW)!;

describe('IDENTITY_API_RATE_LIMITS', () => {
  it('is null when blank and never defaults', () => {
    expect(parseRatePolicy(undefined)).toBeNull();
    expect(parseRatePolicy('  ')).toBeNull();
    expect(POLICY.tiers.map((tier) => tier.id)).toEqual(['base', 'sandbox']);
    expect(POLICY.grantCeilingPerMinute).toBe(6000);
    expect(parseRatePolicy(JSON.stringify({ tiers: [{ id: 'base', burst: 1, refillPerMinute: 1 }] }))!.grantCeilingPerMinute).toBeNull();
  });

  it('stops the service on a value it cannot read, a tier named twice, a sandbox above base or a ceiling at or under base', () => {
    for (const bad of [
      'nope',
      '{"tiers":[]}',
      '{"tiers":[{"id":"base","burst":0,"refillPerMinute":1}]}',
      '{"tiers":[{"id":"gold","burst":1,"refillPerMinute":1}]}',
      '{"tiers":[{"id":"base","burst":1,"refillPerMinute":1},{"id":"base","burst":1,"refillPerMinute":1}]}',
      '{"tiers":[{"id":"base","burst":1,"refillPerMinute":1},{"id":"sandbox","burst":2,"refillPerMinute":1}]}',
      '{"tiers":[{"id":"base","burst":1,"refillPerMinute":10}],"grantCeilingPerMinute":10}',
    ]) {
      expect(() => parseRatePolicy(bad), bad).toThrow(/IDENTITY_API_RATE_LIMITS/);
    }
  });

  it('publishes the tiers, and an empty list while none is set', () => {
    const now = new Date('2026-11-07T00:00:00.000Z');
    expect(publishedTiers(POLICY, now)).toEqual({ asOf: now.toISOString(), tiers: POLICY.tiers, grantCeilingPerMinute: 6000 });
    expect(publishedTiers(null, now)).toEqual({ asOf: now.toISOString(), tiers: [], grantCeilingPerMinute: null });
  });
});

describe('a key’s limit', () => {
  it('follows its environment’s tier; a grant raises a live key’s refill and keeps the burst', () => {
    expect(keyRateLimit(POLICY, { mode: 'live', rate_refill_per_minute_granted: null })).toEqual({
      tier: 'base',
      burst: 60,
      refillPerMinute: 1200,
    });
    expect(keyRateLimit(POLICY, { mode: 'sandbox', rate_refill_per_minute_granted: null })).toEqual({
      tier: 'sandbox',
      burst: 30,
      refillPerMinute: 600,
    });
    expect(keyRateLimit(POLICY, { mode: 'live', rate_refill_per_minute_granted: 2400 })).toEqual({
      tier: 'granted',
      burst: 60,
      refillPerMinute: 2400,
    });
    // A grant never lowers a key below its tier, and a sandbox key is never granted.
    expect(keyRateLimit(POLICY, { mode: 'live', rate_refill_per_minute_granted: 100 })?.tier).toBe('base');
    expect(keyRateLimit(POLICY, { mode: 'sandbox', rate_refill_per_minute_granted: 2400 })?.tier).toBe('sandbox');
  });

  it('is null with no tier set for it, so the edge refuses the call', () => {
    expect(keyRateLimit(null, { mode: 'live', rate_refill_per_minute_granted: 2400 })).toBeNull();
    const baseOnly = parseRatePolicy(JSON.stringify({ tiers: [{ id: 'base', burst: 5, refillPerMinute: 60 }] }));
    expect(keyRateLimit(baseOnly, { mode: 'sandbox', rate_refill_per_minute_granted: null })).toBeNull();
  });
});

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.length > 0 && !name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const DATABASE_URL = testDatabaseUrl();
const tokenConfig = {
  secret: 'an-identity-api-rate-limits-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const available = await postgresAvailable(DATABASE_URL);

if (!available) {
  describe.skip('API rate limits against Postgres (Postgres unavailable)', () => {
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
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, randomBytes(32).toString('base64'), undefined, undefined, 25);
  await rank.seedTiers();
  let n = 0;
  const unique = () => `rl${process.pid}${++n}`;
  const today = new Date().toISOString().slice(0, 10);
  const inDays = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

  beforeEach(async () => {
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  async function person() {
    const handle = unique();
    const session = await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
    return session.userId;
  }

  async function key(userId: string, mode: 'live' | 'sandbox' = 'live', secret = `ifc_${unique()}_TEST_secret_value`) {
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO api_keys (user_id, name, key_hash, key_prefix, scopes, mode)
      VALUES (${userId}, ${unique()}, ${hashToken(secret)}, ${secret.slice(0, 12)}, ${['trade:read']}, ${mode})
      RETURNING id
    `;
    return { id: row!.id, secret };
  }

  const ask = (keyId: string, over: Partial<Parameters<typeof createLimitRequest>[3]> = {}) => ({
    keyId,
    askedPerMinute: 4800,
    spikeStartsOn: inDays(7),
    spikeEndsOn: inDays(8),
    note: 'TEST: a launch week',
    requestId: `limit-request:${unique()}`,
    ...over,
  });

  const codeOf = async (run: Promise<unknown>) => {
    try {
      await run;
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return 'resolved';
  };

  describe('a request for a higher limit', () => {
    it('is recorded once with what the key had, and a repeat of the same submission returns the same record', async () => {
      const userId = await person();
      const { id } = await key(userId);
      const input = ask(id);
      const first = await createLimitRequest(db.sql, POLICY, userId, input);
      expect(first).toMatchObject({
        keyId: id,
        askedPerMinute: 4800,
        currentPerMinute: 1200,
        spikeStartsOn: inDays(7),
        spikeEndsOn: inDays(8),
        note: 'TEST: a launch week',
        status: 'waiting',
        grantedPerMinute: null,
        reviewedAt: null,
      });
      expect(await createLimitRequest(db.sql, POLICY, userId, input)).toEqual(first);
      expect((await listMyLimitRequests(db.sql, userId)).requests).toEqual([first]);
    });

    it('refuses while the tiers are blank, and records nothing', async () => {
      const userId = await person();
      const { id } = await key(userId);
      expect(await codeOf(createLimitRequest(db.sql, null, userId, ask(id)))).toBe('identity.rate_limits_unset');
      expect((await listMyLimitRequests(db.sql, userId)).requests).toEqual([]);
    });

    it('refuses someone else’s key, a revoked key, an ask not above the key’s refill, a bad spike and a second waiting request', async () => {
      const userId = await person();
      const other = await person();
      const { id } = await key(userId);
      const theirs = await key(other);
      expect(await codeOf(createLimitRequest(db.sql, POLICY, userId, ask(theirs.id)))).toBe('identity.key_not_found');
      expect(await codeOf(createLimitRequest(db.sql, POLICY, userId, ask(id, { askedPerMinute: 1200 })))).toBe('identity.limit_not_higher');
      for (const spike of [
        { spikeStartsOn: inDays(1), spikeEndsOn: null },
        { spikeStartsOn: inDays(3), spikeEndsOn: inDays(2) },
        { spikeStartsOn: '2020-01-01', spikeEndsOn: '2020-01-02' },
        { spikeStartsOn: '2026-02-30', spikeEndsOn: '2026-03-01' },
      ]) {
        expect(await codeOf(createLimitRequest(db.sql, POLICY, userId, ask(id, spike))), JSON.stringify(spike)).toBe(
          'identity.limit_spike_invalid',
        );
      }
      expect((await createLimitRequest(db.sql, POLICY, userId, ask(id, { spikeStartsOn: today, spikeEndsOn: today }))).status).toBe(
        'waiting',
      );
      expect(await codeOf(createLimitRequest(db.sql, POLICY, userId, ask(id)))).toBe('identity.limit_request_open');
      const sandbox = await key(userId, 'sandbox');
      expect(await codeOf(createLimitRequest(db.sql, POLICY, userId, ask(sandbox.id)))).toBe('identity.limit_key_sandbox');
      const revoked = await key(userId);
      await db.sql`UPDATE api_keys SET revoked = true, revoked_at = now(), revoked_cause = 'owner' WHERE id = ${revoked.id}`;
      expect(await codeOf(createLimitRequest(db.sql, POLICY, userId, ask(revoked.id)))).toBe('identity.key_not_live');
      expect((await listMyLimitRequests(db.sql, userId)).requests).toHaveLength(1);
    });
  });

  describe('a reviewer’s decision', () => {
    async function waiting() {
      const userId = await person();
      const reviewer = await person();
      const k = await key(userId);
      const request = await createLimitRequest(db.sql, POLICY, userId, ask(k.id));
      return { userId, reviewer, key: k, request };
    }

    const auditOf = (requestId: string) => db.sql`SELECT * FROM api_limit_audit WHERE request_id = ${requestId}`;

    it('grants part of it: the request, the key’s refill and one audit entry change together', async () => {
      const { reviewer, key: k, request } = await waiting();
      const decided = await reviewLimitRequest(db.sql, POLICY, reviewer, {
        decision: 'grant',
        id: request.id,
        grantedPerMinute: 2400,
        reason: 'TEST: part of it',
      });
      expect(decided).toMatchObject({ status: 'granted_in_part', grantedPerMinute: 2400 });
      expect(decided.reviewedAt).not.toBeNull();
      const [row] = await db.sql<Array<{ rate_refill_per_minute_granted: number }>>`
        SELECT rate_refill_per_minute_granted FROM api_keys WHERE id = ${k.id}
      `;
      expect(row!.rate_refill_per_minute_granted).toBe(2400);
      const audit = await auditOf(request.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_id: reviewer,
        decision: 'granted_in_part',
        asked_per_minute: 4800,
        previous_per_minute: 1200,
        granted_per_minute: 2400,
        reason: 'TEST: part of it',
      });
      // A second decision on the same request is refused and writes no second entry.
      expect(
        await codeOf(reviewLimitRequest(db.sql, POLICY, reviewer, { decision: 'refuse', id: request.id, reason: 'TEST: again' })),
      ).toBe('identity.limit_request_decided');
      expect(await auditOf(request.id)).toHaveLength(1);
      // The desk shows the decision and its one entry.
      const desk = await limitDesk(db.sql, POLICY);
      expect(desk.requests.find((r) => r.id === request.id)).toMatchObject({ status: 'granted_in_part', grantedPerMinute: 2400 });
      expect(desk.audit.filter((entry) => entry.requestId === request.id)).toHaveLength(1);
      // The audit entry is the record of the decision: it outlives the key (and its request) it names.
      const keyName = desk.audit.find((entry) => entry.requestId === request.id)!.keyName;
      await db.sql`DELETE FROM api_keys WHERE id = ${k.id}`;
      const after = await limitDesk(db.sql, POLICY);
      expect(after.audit.filter((entry) => entry.requestId === request.id)).toEqual([
        expect.objectContaining({ keyName, decision: 'granted_in_part', grantedPerMinute: 2400 }),
      ]);
    });

    it('a grant of all of it is granted; a refusal grants nothing and writes one entry', async () => {
      const a = await waiting();
      expect(
        (
          await reviewLimitRequest(db.sql, POLICY, a.reviewer, {
            decision: 'grant',
            id: a.request.id,
            grantedPerMinute: 4800,
            reason: 'TEST: all',
          })
        ).status,
      ).toBe('granted');
      const b = await waiting();
      const refused = await reviewLimitRequest(db.sql, POLICY, b.reviewer, { decision: 'refuse', id: b.request.id, reason: 'TEST: no' });
      expect(refused).toMatchObject({ status: 'refused', grantedPerMinute: null });
      const [row] = await db.sql<Array<{ rate_refill_per_minute_granted: number | null }>>`
        SELECT rate_refill_per_minute_granted FROM api_keys WHERE id = ${b.key.id}
      `;
      expect(row!.rate_refill_per_minute_granted).toBeNull();
      expect(await auditOf(b.request.id)).toHaveLength(1);
    });

    it('refuses, changing nothing: above the ask, at or under the key’s refill, above the ceiling, a blank ceiling, blank tiers, the reviewer’s own key', async () => {
      const { userId, reviewer, request } = await waiting();
      const grant = (grantedPerMinute: number, policy: RatePolicy | null = POLICY, actor = reviewer) =>
        codeOf(reviewLimitRequest(db.sql, policy, actor, { decision: 'grant', id: request.id, grantedPerMinute, reason: 'TEST: try' }));
      expect(await grant(4801)).toBe('identity.limit_grant_invalid');
      expect(await grant(1200)).toBe('identity.limit_grant_invalid');
      const lowCeiling = parseRatePolicy(JSON.stringify({ tiers: POLICY.tiers, grantCeilingPerMinute: 2000 }));
      expect(await grant(2400, lowCeiling)).toBe('identity.rate_grant_above_ceiling');
      const noCeiling = parseRatePolicy(JSON.stringify({ tiers: POLICY.tiers }));
      expect(await grant(2400, noCeiling)).toBe('identity.rate_grant_ceiling_unset');
      expect(await grant(2400, null)).toBe('identity.rate_limits_unset');
      expect(await grant(2400, POLICY, userId)).toBe('identity.limit_review_own');
      expect(await auditOf(request.id)).toHaveLength(0);
      expect((await listMyLimitRequests(db.sql, userId)).requests[0]).toMatchObject({ status: 'waiting', grantedPerMinute: null });
    });
  });

  describe('the key exchange', () => {
    it('carries the key’s limit from its live row: the tier, the grant, and null while no tier is set', async () => {
      const userId = await person();
      const live = await key(userId);
      const fake = {
        exchangeApiKey: async () => ({
          accessToken: 't',
          expiresAt: new Date(),
          userId,
          keyId: live.id,
          scopes: ['trade:read'],
          mode: 'live' as const,
        }),
      } as unknown as AuthService;
      installApiKeyRateExchange(fake, db.sql, POLICY);
      expect((await fake.exchangeApiKey(live.secret)).rateLimit).toEqual({ tier: 'base', burst: 60, refillPerMinute: 1200 });
      await db.sql`UPDATE api_keys SET rate_refill_per_minute_granted = 2400 WHERE id = ${live.id}`;
      expect((await fake.exchangeApiKey(live.secret)).rateLimit).toEqual({ tier: 'granted', burst: 60, refillPerMinute: 2400 });
      const blank = {
        exchangeApiKey: fake.exchangeApiKey,
      } as unknown as AuthService;
      installApiKeyRateExchange(blank, db.sql, null);
      expect((await blank.exchangeApiKey(live.secret)).rateLimit).toBeNull();
    });
  });
}
