import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { bindApiKeyIpAllowlist } from './auth-service-ip.js';
import { PlaceDoor } from './place-door.js';
import { rotateApiKey } from './rotate-api-key.js';
import {
  ApiKeyRequestSignError,
  canonicalRequest,
  decideApiKeyExchange,
  hashBody,
  installApiKeyRequestSignExchange,
  requestSignAls,
  rotateSigningSecret,
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

/** The TEST owner window the stack runs with (tooling/profiles/test-owner-values/identity.json). */
const WINDOW = 300;

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
  const encKey = randomBytes(32);
  installApiKeyRequestSignExchange(auth, db.sql, encKey, WINDOW);
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
      const first = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        {
          requireSignature: true,
          requireNonEmptyIpAllowlist: false,
        },
        encKey,
      );
      expect(first.signingSecret?.startsWith('ifs_')).toBe(true);
      const stored = await db.sql<Array<{ request_signing_secret: string | null }>>`
        SELECT request_signing_secret FROM api_keys WHERE id = ${created.id}
      `;
      expect(stored[0]?.request_signing_secret?.startsWith('enc:v1:')).toBe(true);
      expect(stored[0]?.request_signing_secret).not.toContain(first.signingSecret);
      const second = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        {
          requireSignature: true,
          requireNonEmptyIpAllowlist: false,
        },
        encKey,
      );
      expect(second.signingSecret).toBeNull();
      await expect(
        setApiKeyRequestSigning(
          db.sql,
          other.userId,
          created.id,
          {
            requireSignature: true,
            requireNonEmptyIpAllowlist: false,
          },
          encKey,
        ),
      ).rejects.toBeInstanceOf(ApiKeyRequestSignError);
      const snap = await door.getApiKeyOwnership(created.id);
      expect(snap && 'requestSigningSecret' in snap).toBe(false);
    });

    it('refuses unsigned, stale, tampered, and replayed calls; accepts a fresh signature', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        {
          requireSignature: true,
          requireNonEmptyIpAllowlist: false,
        },
        encKey,
      );
      const secret = enabled.signingSecret!;
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'unsigned',
      });
      await expect(auth.exchangeApiKey(created.key)).rejects.toMatchObject({ code: 'auth.request_unsigned' });

      const stale = signed(secret, 'nonce-stale-1', '{"amount":"1.10"}', -(WINDOW + 5));
      await expect(decideApiKeyExchange(db.sql, created.key, stale, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'stale',
      });
      await expect(requestSignAls.run(stale, () => auth.exchangeApiKey(created.key))).rejects.toMatchObject({
        code: 'auth.request_stale',
      });

      const good = signed(secret, 'nonce-fresh-1');
      const tampered = { ...good, bodyHash: hashBody('{"amount":"9.99"}') };
      await expect(decideApiKeyExchange(db.sql, created.key, tampered, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'tampered',
      });
      await expect(requestSignAls.run(tampered, () => auth.exchangeApiKey(created.key))).rejects.toMatchObject({
        code: 'auth.request_tampered',
      });
      // A blank owner window refuses the same fresh, valid request and consumes no nonce.
      await expect(decideApiKeyExchange(db.sql, created.key, good, new Date(), encKey, null)).resolves.toEqual({
        ok: false,
        reason: 'window_unset',
      });

      await expect(requestSignAls.run(good, () => auth.exchangeApiKey(created.key))).resolves.toMatchObject({
        userId: owner.userId,
        requireSignature: true,
      });
      await expect(decideApiKeyExchange(db.sql, created.key, good, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'replay',
      });
      await expect(requestSignAls.run(good, () => auth.exchangeApiKey(created.key))).rejects.toMatchObject({
        code: 'auth.request_replay',
      });
    });

    it('refuses an expired key that must sign before any signature or key check, on the clock it was given', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        { requireSignature: true, requireNonEmptyIpAllowlist: false },
        encKey,
      );
      const expiresAt = new Date(Date.now() + 60_000);
      await db.sql`UPDATE api_keys SET expires_at = ${expiresAt} WHERE id = ${created.id}`;
      // Before the end the key still signs: an unsigned call is refused as unsigned, never waved through.
      await expect(
        decideApiKeyExchange(db.sql, created.key, undefined, new Date(expiresAt.getTime() - 1), encKey, WINDOW),
      ).resolves.toEqual({
        ok: false,
        reason: 'unsigned',
      });
      // At the end it is expired whatever the database clock says, and the exchange refuses it without minting.
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, expiresAt, encKey, WINDOW)).resolves.toEqual({
        ok: false,
        expired: true,
      });
      await db.sql`UPDATE api_keys SET expires_at = ${new Date(Date.now() - 1_000)} WHERE id = ${created.id}`;
      await expect(auth.exchangeApiKey(created.key)).rejects.toMatchObject({ code: 'auth.api_key_expired' });
    });

    it('refuses an empty IP allowlist only after the key opts in', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        {
          requireSignature: false,
          requireNonEmptyIpAllowlist: true,
        },
        encKey,
      );
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'ip_allowlist_required',
      });
      await bindApiKeyIpAllowlist(db.sql, owner.userId, created.id, ['203.0.113.10']);
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date(), encKey, WINDOW)).resolves.toMatchObject({ ok: true });
    });

    it('deletes nonces older than the window when a new nonce is stored', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        {
          requireSignature: true,
          requireNonEmptyIpAllowlist: false,
        },
        encKey,
      );
      const old = new Date(Date.now() - (WINDOW + 30) * 1000);
      await db.sql`
        INSERT INTO api_key_request_nonces (key_id, nonce, seen_at, expires_at)
        VALUES (${created.id}, ${'nonce-old-01'}, ${old}, ${old})
      `;
      const fresh = signed(enabled.signingSecret!, 'nonce-new-01');
      await expect(decideApiKeyExchange(db.sql, created.key, fresh, new Date(), encKey, WINDOW)).resolves.toMatchObject({ ok: true });
      const left = await db.sql<Array<{ nonce: string }>>`
        SELECT nonce FROM api_key_request_nonces WHERE key_id = ${created.id} ORDER BY nonce
      `;
      expect(left.map((row) => row.nonce)).toEqual(['nonce-new-01']);
    });

    it('refuses a replay while a client clock 240s ahead is still inside the acceptance window', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        { requireSignature: true, requireNonEmptyIpAllowlist: false },
        encKey,
      );
      const serverNow = new Date('2026-10-16T01:00:00.000Z');
      const signedAt = Math.floor(serverNow.getTime() / 1000) + 240;
      const nonce = 'nonce-skew-01';
      const path = '/api/pay/v1/payments';
      const method = 'POST';
      const bodyHash = hashBody('{"amount":"1.10"}');
      const material: RequestSignMaterial = {
        method,
        path,
        timestamp: String(signedAt),
        nonce,
        bodyHash,
        signature: signRequest(enabled.signingSecret!, canonicalRequest({ method, path, timestamp: String(signedAt), nonce, bodyHash })),
      };
      await expect(decideApiKeyExchange(db.sql, created.key, material, serverNow, encKey, WINDOW)).resolves.toMatchObject({ ok: true });
      for (const delta of [301, 400, 540]) {
        const later = new Date(serverNow.getTime() + delta * 1000);
        await expect(decideApiKeyExchange(db.sql, created.key, material, later, encKey, WINDOW)).resolves.toEqual({
          ok: false,
          reason: 'replay',
        });
      }
      const staleAt = new Date(serverNow.getTime() + 541 * 1000);
      await expect(decideApiKeyExchange(db.sql, created.key, material, staleAt, encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'stale',
      });
    });

    it('still refuses a used nonce as a replay after the owner widens the window on restart', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        { requireSignature: true, requireNonEmptyIpAllowlist: false },
        encKey,
      );
      const serverNow = new Date('2026-10-17T01:00:00.000Z');
      const timestamp = String(Math.floor(serverNow.getTime() / 1000));
      const method = 'POST';
      const path = '/api/v1/trade/orders';
      const nonce = 'nonce-widen-01';
      const bodyHash = hashBody('{"quantity":"1"}');
      const material: RequestSignMaterial = {
        method,
        path,
        timestamp,
        nonce,
        bodyHash,
        signature: signRequest(enabled.signingSecret!, canonicalRequest({ method, path, timestamp, nonce, bodyHash })),
      };
      await expect(decideApiKeyExchange(db.sql, created.key, material, serverNow, encKey, 60)).resolves.toMatchObject({ ok: true });
      // Two minutes on, under a window raised to an hour, the request is fresh again by its age; its nonce is not.
      const later = new Date(serverNow.getTime() + 120_000);
      await expect(decideApiKeyExchange(db.sql, created.key, material, later, encKey, 3600)).resolves.toEqual({
        ok: false,
        reason: 'replay',
      });
    });

    it('treats a catch-all allowlist as empty when the key requires one', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        { requireSignature: false, requireNonEmptyIpAllowlist: true },
        encKey,
      );
      for (const entry of ['0.0.0.0/0', '::/0']) {
        await db.sql`UPDATE api_keys SET ip_allowlist = ${[entry]} WHERE id = ${created.id}`;
        await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date(), encKey, WINDOW)).resolves.toEqual({
          ok: false,
          reason: 'ip_allowlist_required',
        });
      }
      await db.sql`UPDATE api_keys SET ip_allowlist = ${['203.0.113.10', '0.0.0.0/0']} WHERE id = ${created.id}`;
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date(), encKey, WINDOW)).resolves.toMatchObject({ ok: true });
    });

    it('refuses an unsigned call on a rotated key and returns a new secret once', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        { requireSignature: true, requireNonEmptyIpAllowlist: true },
        encKey,
      );
      const rotated = await rotateApiKey(
        auth,
        db.sql,
        { userId: owner.userId, keyId: created.id, grantorScopes: ['trade:read', 'trade:place'] },
        encKey,
      );
      expect(rotated.signingSecret?.startsWith('ifs_')).toBe(true);
      expect(rotated.signingSecret).not.toBe(enabled.signingSecret);
      await expect(decideApiKeyExchange(db.sql, rotated.key, undefined, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'ip_allowlist_required',
      });
      await db.sql`UPDATE api_keys SET ip_allowlist = ${['203.0.113.10']} WHERE id = ${rotated.id}`;
      await expect(decideApiKeyExchange(db.sql, rotated.key, undefined, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'unsigned',
      });
      // The rotated-away key is dead, and its holder is told so (DV-errors-02).
      await expect(auth.exchangeApiKey(created.key)).rejects.toMatchObject({ code: 'auth.api_key_revoked' });
      const flags = await db.sql<
        Array<{ require_signature: boolean; require_non_empty_ip_allowlist: boolean; request_signing_secret: string }>
      >`
        SELECT require_signature, require_non_empty_ip_allowlist, request_signing_secret
        FROM api_keys WHERE id = ${rotated.id}
      `;
      expect(flags[0]?.require_signature).toBe(true);
      expect(flags[0]?.require_non_empty_ip_allowlist).toBe(true);
      expect(flags[0]?.request_signing_secret.startsWith('enc:v1:')).toBe(true);
      expect(flags[0]?.request_signing_secret).not.toContain(rotated.signingSecret);
    });

    it('rotates the signing secret in one transaction without an unsigned gap', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        { requireSignature: true, requireNonEmptyIpAllowlist: false },
        encKey,
      );
      const oldSecret = enabled.signingSecret!;
      const rotated = await rotateSigningSecret(db.sql, owner.userId, created.id, encKey);
      expect(rotated.signingSecret.startsWith('ifs_')).toBe(true);
      expect(rotated.signingSecret).not.toBe(oldSecret);
      const oldMaterial = signed(oldSecret, 'nonce-old-sec');
      await expect(decideApiKeyExchange(db.sql, created.key, oldMaterial, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'tampered',
      });
      await expect(decideApiKeyExchange(db.sql, created.key, undefined, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'unsigned',
      });
      const fresh = signed(rotated.signingSecret, 'nonce-new-sec');
      await expect(decideApiKeyExchange(db.sql, created.key, fresh, new Date(), encKey, WINDOW)).resolves.toMatchObject({ ok: true });
      const row = await db.sql<Array<{ require_signature: boolean; request_signing_secret: string }>>`
        SELECT require_signature, request_signing_secret FROM api_keys WHERE id = ${created.id}
      `;
      expect(row[0]?.require_signature).toBe(true);
      expect(row[0]?.request_signing_secret.startsWith('enc:v1:')).toBe(true);
      await expect(
        setApiKeyRequestSigning(db.sql, owner.userId, created.id, { requireSignature: true, requireNonEmptyIpAllowlist: false }, null),
      ).rejects.toMatchObject({ reason: 'auth.not_configured' });
    });

    it('lists signing posture and the IP allowlist and never the secret', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        { requireSignature: true, requireNonEmptyIpAllowlist: true },
        encKey,
      );
      await bindApiKeyIpAllowlist(db.sql, owner.userId, created.id, ['203.0.113.10']);
      const listed = await auth.listApiKeys(owner.userId, 20);
      const row = listed.find((key) => key.id === created.id);
      expect(row).toMatchObject({
        require_signature: true,
        require_non_empty_ip_allowlist: true,
        ip_allowlist: ['203.0.113.10'],
      });
      const text = JSON.stringify(row);
      expect(text).not.toContain('request_signing_secret');
      expect(text).not.toContain(enabled.signingSecret);
      expect(text).not.toContain('enc:v1:');
      expect(text).not.toContain(created.key);
    });

    it('an IP-only signing write and an IP bind keep the secret and the signing flag', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(
        db.sql,
        owner.userId,
        created.id,
        { requireSignature: true, requireNonEmptyIpAllowlist: false },
        encKey,
      );
      const before = await db.sql<Array<{ request_signing_secret: string; require_signature: boolean }>>`
        SELECT request_signing_secret, require_signature FROM api_keys WHERE id = ${created.id}
      `;
      const ipOnly = await setApiKeyRequestSigning(db.sql, owner.userId, created.id, { requireNonEmptyIpAllowlist: true }, encKey);
      expect(ipOnly).toMatchObject({ requireSignature: true, requireNonEmptyIpAllowlist: true, signingSecret: null });
      const bound = await bindApiKeyIpAllowlist(db.sql, owner.userId, created.id, ['203.0.113.10']);
      expect(bound).toMatchObject({
        requireSignature: true,
        requireNonEmptyIpAllowlist: true,
        ipAllowlist: ['203.0.113.10'],
      });
      const after = await db.sql<Array<{ request_signing_secret: string; require_signature: boolean }>>`
        SELECT request_signing_secret, require_signature FROM api_keys WHERE id = ${created.id}
      `;
      expect(after[0]?.require_signature).toBe(true);
      expect(after[0]?.request_signing_secret).toBe(before[0]?.request_signing_secret);
      expect(after[0]?.request_signing_secret).not.toContain(enabled.signingSecret);
      const cleared = await setApiKeyRequestSigning(db.sql, owner.userId, created.id, { requireSignature: false }, encKey);
      expect(cleared.requireSignature).toBe(false);
      const wiped = await db.sql<Array<{ request_signing_secret: string | null; require_non_empty_ip_allowlist: boolean }>>`
        SELECT request_signing_secret, require_non_empty_ip_allowlist FROM api_keys WHERE id = ${created.id}
      `;
      expect(wiped[0]?.request_signing_secret).toBeNull();
      expect(wiped[0]?.require_non_empty_ip_allowlist).toBe(true);
    });

    it('claims only a confirmed stored mailbox, and sign-in does not wait on pay', async () => {
      const seen: Array<{ userId: string; email: string }> = [];
      let releaseClaim: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      let claimFinished: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        claimFinished = resolve;
      });
      auth.useMerchantEmailInviteClaimer({
        async claim(input) {
          seen.push(input);
          await gate;
          claimFinished();
          throw new Error('pay down');
        },
      });
      try {
        const handle = unique();
        const email = `${handle}@Example.com`;
        const session = await auth.register({ handle, email, password: 'correct horse battery staple', region: 'DE' });
        await expect(auth.login({ identifier: handle, password: 'correct horse battery staple' })).resolves.toMatchObject({
          userId: session.userId,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(seen).toEqual([]);
        await db.sql`UPDATE users SET email_verified_at = now() WHERE id = ${session.userId}`;
        const started = Date.now();
        await expect(auth.login({ identifier: email, password: 'correct horse battery staple' })).resolves.toMatchObject({
          userId: session.userId,
        });
        expect(Date.now() - started).toBeLessThan(1_000);
        releaseClaim();
        await finished;
        expect(seen).toEqual([{ userId: session.userId, email }]);
        expect(seen[0]?.email).not.toBe(handle);
      } finally {
        releaseClaim();
        auth.useMerchantEmailInviteClaimer(undefined);
      }
    });

    it('names a too-new timestamp apart from a stale one', async () => {
      const owner = await register();
      const created = await mint(owner.userId);
      const enabled = await setApiKeyRequestSigning(db.sql, owner.userId, created.id, { requireSignature: true }, encKey);
      const ahead = signed(enabled.signingSecret!, 'nonce-ahead-1', '{"amount":"1.10"}', WINDOW + 5);
      await expect(decideApiKeyExchange(db.sql, created.key, ahead, new Date(), encKey, WINDOW)).resolves.toEqual({
        ok: false,
        reason: 'future',
      });
      await expect(requestSignAls.run(ahead, () => auth.exchangeApiKey(created.key))).rejects.toMatchObject({
        code: 'auth.request_future',
      });
    });

    it('keeps signing on for a key that places orders unless the owner makes it optional', async () => {
      const owner = await register();
      const created = await auth.createApiKey({
        userId: owner.userId,
        name: 'trader',
        scopes: ['trade:read', 'trade:write'],
        grantorScopes: ['trade:read', 'trade:write'],
      });
      await setApiKeyRequestSigning(db.sql, owner.userId, created.id, { requireSignature: true }, encKey);
      await expect(setApiKeyRequestSigning(db.sql, owner.userId, created.id, { requireSignature: false }, encKey)).rejects.toMatchObject({
        reason: 'auth.signing_required',
      });
      const [still] = await db.sql<Array<{ require_signature: boolean }>>`SELECT require_signature FROM api_keys WHERE id = ${created.id}`;
      expect(still!.require_signature).toBe(true);
      await expect(
        setApiKeyRequestSigning(db.sql, owner.userId, created.id, { requireSignature: false }, encKey, true),
      ).resolves.toMatchObject({ requireSignature: false, signingSecret: null });
    });

    it('names a revoked or ended key, and a frozen account, only to the holder of the full key', async () => {
      const owner = await register();
      const gone = await mint(owner.userId);
      await auth.revokeApiKey(owner.userId, gone.id);
      await expect(auth.exchangeApiKey(gone.key)).rejects.toMatchObject({ code: 'auth.api_key_revoked' });
      const ended = await mint(owner.userId);
      await db.sql`UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = ${ended.id}`;
      await expect(auth.exchangeApiKey(ended.key)).rejects.toMatchObject({ code: 'auth.api_key_expired' });
      // A key that matches no row says nothing about any real key.
      await expect(auth.exchangeApiKey(`${gone.key.slice(0, -4)}zzzz`)).rejects.toMatchObject({ code: 'auth.invalid_credentials' });
      const live = await mint(owner.userId);
      await auth.freezeIdentity(owner.userId);
      await expect(auth.exchangeApiKey(live.key)).rejects.toMatchObject({ code: 'auth.account_frozen' });
      await expect(auth.exchangeApiKey(gone.key)).rejects.toMatchObject({ code: 'auth.account_frozen' });
    });
  });
}
