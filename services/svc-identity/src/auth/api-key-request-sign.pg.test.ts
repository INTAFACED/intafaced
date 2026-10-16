import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb, postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { bindApiKeyIpAllowlist } from './auth-service-ip.js';
import { PlaceDoor } from './place-door.js';
import {
  ApiKeyRequestSignError,
  REQUEST_SIGN_WINDOW_SECONDS,
  canonicalRequest,
  decideApiKeyExchange,
  hashBody,
  installApiKeyRequestSignExchange,
  requestSignAls,
  setApiKeyRequestSigning,
  signRequest,
  type RequestSignMaterial,
} from './api-key-request-sign.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@127.0.0.1:54935/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('api key request signature (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 25);
  installApiKeyRequestSignExchange(auth, db.sql);
  const door = new PlaceDoor(db.sql);
  await rank.seedTiers();

  let counter = 0;
  const unique = () => `s${process.pid}${++counter}`;
  const register = () => {
    const handle = unique();
    return auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' });
  };
  const mint = async (userId: string) =>
    auth.createApiKey({
      userId,
      name: 'bot',
      scopes: ['trade:read'],
      grantorScopes: ['trade:read', 'trade:place'],
    });

  function signed(secret: string, nonce: string, body = '{"amount":"1.10"}', skewSeconds = 0): RequestSignMaterial {
    const timestamp = String(Math.floor(Date.now() / 1000) + skewSeconds);
    const path = '/api/pay/v1/payments';
    const method = 'POST';
    const bodyHash = hashBody(body);
    return {
      method,
      path,
      timestamp,
      nonce,
      bodyHash,
      signature: signRequest(secret, canonicalRequest({ method, path, timestamp, nonce, bodyHash })),
    };
  }

  beforeEach(async () => {
    bus.reset();
    await db.truncateAll();
    await rank.seedTiers();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('api key request signature (Postgres)', () => {
    it('leaves unsigned keys open and does not invent a signing secret', async () => {
      const session = await register();
      const created = await mint(session.userId);
      await expect(auth.exchangeApiKey(created.key)).resolves.toMatchObject({ userId: session.userId, requireSignature: false });
      const snap = await door.getApiKeyOwnership(created.id);
      expect(snap?.requireSignature).toBe(false);
      expect(snap?.requireNonEmptyIpAllowlist).toBe(false);
      expect(snap && 'requestSigningSecret' in snap).toBe(false);
    });

    it('returns the signing secret once, and only to the key owner', async () => {
      const owner = await register();
      const other = await register();
      const created = await mint(owner.userId);
      const first = await setApiKeyRequestSigning(db.sql, owner.userId, created.id, {
        requireSignature: true,
        requireNonEmptyIpAllowlist: false,
      });
      expect(first.signingSecret?.startsWith('ifs_')).toBe(true);
      const second = await setApiKeyRequestSigning(db.sql, owner.userId, created.id, {
        requireSignature: true,
        requireNonEmptyIpAllowlist: false,
      });
      expect(second.signingSecret).toBeNull();
      await expect(
        setApiKeyRequestSigning(db.sql, other.userId, created.id, {
          requireSignature: true,
          requireNonEmptyIpAllowlist: false,
        }),
      ).rejects.toBeInstanceOf(ApiKeyRequestSignError);
      const snap = await door.getApiKeyOwnership(created.id);
      expect(snap && 'requestSigningSecret' in snap).toBe(false);
    });

    it('refuses unsigned, stale, tampered, and replayed calls; accepts a fresh signature', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(db.sql, owner.userId, created.id, {
        requireSignature: true,
        requireNonEmptyIpAllowlist: false,
      });
      const secret = enabled.signingSecret!;
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date())).resolves.toEqual({
        ok: false,
        reason: 'unsigned',
      });
      await expect(auth.exchangeApiKey(created.key)).rejects.toMatchObject({ code: 'auth.invalid_credentials' });

      const stale = signed(secret, 'nonce-stale-1', '{"amount":"1.10"}', -(REQUEST_SIGN_WINDOW_SECONDS + 5));
      await expect(decideApiKeyExchange(db.sql, created.key, stale, new Date())).resolves.toEqual({ ok: false, reason: 'stale' });

      const good = signed(secret, 'nonce-fresh-1');
      const tampered = { ...good, bodyHash: hashBody('{"amount":"9.99"}') };
      await expect(decideApiKeyExchange(db.sql, created.key, tampered, new Date())).resolves.toEqual({ ok: false, reason: 'tampered' });

      await expect(requestSignAls.run(good, () => auth.exchangeApiKey(created.key))).resolves.toMatchObject({
        userId: owner.userId,
        requireSignature: true,
      });
      await expect(decideApiKeyExchange(db.sql, created.key, good, new Date())).resolves.toEqual({ ok: false, reason: 'replay' });
      await expect(requestSignAls.run(good, () => auth.exchangeApiKey(created.key))).rejects.toMatchObject({
        code: 'auth.invalid_credentials',
      });
    });

    it('refuses an empty IP allowlist only after the key opts in', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      await setApiKeyRequestSigning(db.sql, owner.userId, created.id, {
        requireSignature: false,
        requireNonEmptyIpAllowlist: true,
      });
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date())).resolves.toEqual({
        ok: false,
        reason: 'ip_allowlist_required',
      });
      await bindApiKeyIpAllowlist(db.sql, owner.userId, created.id, ['203.0.113.10']);
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date())).resolves.toMatchObject({ ok: true });
    });

    it('deletes nonces older than the window when a new nonce is stored', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(db.sql, owner.userId, created.id, {
        requireSignature: true,
        requireNonEmptyIpAllowlist: false,
      });
      const old = new Date(Date.now() - (REQUEST_SIGN_WINDOW_SECONDS + 30) * 1000);
      await db.sql`
        INSERT INTO api_key_request_nonces (key_id, nonce, seen_at)
        VALUES (${created.id}, ${'nonce-old-01'}, ${old})
      `;
      const fresh = signed(enabled.signingSecret!, 'nonce-new-01');
      await expect(decideApiKeyExchange(db.sql, created.key, fresh, new Date())).resolves.toMatchObject({ ok: true });
      const left = await db.sql<Array<{ nonce: string }>>`
        SELECT nonce FROM api_key_request_nonces WHERE key_id = ${created.id} ORDER BY nonce
      `;
      expect(left.map((row) => row.nonce)).toEqual(['nonce-new-01']);
    });
  });
}
