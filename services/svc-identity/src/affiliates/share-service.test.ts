import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { MemoryShareStore, ShareError, ShareService } from './share-service.js';

const REF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('MemoryShareStore (affiliates share tokens)', () => {
  it('createShare is idempotent for one live token', () => {
    const store = new MemoryShareStore();
    store.rememberUser(REF);
    const a = store.createShare(REF);
    const b = store.createShare(REF);
    expect(a.token).toBe(b.token);
    expect(a.hits).toBe(0);
  });

  it('shareHits increments; revoke refuses later hits (no attribute path)', () => {
    const store = new MemoryShareStore();
    store.rememberUser(REF);
    const rec = store.createShare(REF);
    expect(store.shareHits(rec.token).hits).toBe(1);
    expect(store.shareHits(rec.token).hits).toBe(2);
    store.revokeShare(REF);
    expect(() => store.shareHits(rec.token)).toThrow(ShareError);
    try {
      store.shareHits(rec.token);
    } catch (err) {
      expect((err as ShareError).code).toBe('share.revoked');
    }
  });

  it('forgotten / deleted profile refuses hits (named share.profile_gone)', () => {
    const store = new MemoryShareStore();
    store.rememberUser(REF);
    const rec = store.createShare(REF);
    store.forgetUser(REF);
    expect(() => store.shareHits(rec.token)).toThrow(ShareError);
    try {
      store.shareHits(rec.token);
    } catch (err) {
      expect((err as ShareError).code).toBe('share.profile_gone');
    }
  });

  it('unknown token refuses; revoke with no token is share.not_found', () => {
    const store = new MemoryShareStore();
    store.rememberUser(REF);
    try {
      store.shareHits(OTHER);
    } catch (err) {
      expect((err as ShareError).code).toBe('share.unknown');
    }
    try {
      store.revokeShare(REF);
    } catch (err) {
      expect((err as ShareError).code).toBe('share.not_found');
    }
  });

  it('createShare after revoke mints a new token; old token stays dead', () => {
    const store = new MemoryShareStore();
    store.rememberUser(REF);
    const first = store.createShare(REF);
    store.revokeShare(REF);
    const second = store.createShare(REF);
    expect(second.token).not.toBe(first.token);
    expect(() => store.shareHits(first.token)).toThrow(ShareError);
    expect(store.shareHits(second.token).hits).toBe(1);
  });
});

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('ShareService SQL (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const share = new ShareService(db.sql);

  async function seedUser(id: string, handle: string) {
    await db.sql`
      INSERT INTO users (id, handle, email, password_hash, status)
      VALUES (${id}, ${handle}, ${handle + '@example.com'}, 'x', 'active')
    `;
  }

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('ShareService SQL', () => {
    it('createShare / shareHits / revokeShare; closed user is profile_gone', async () => {
      await seedUser(REF, 'sharer');
      const rec = await share.createShare(REF);
      const again = await share.createShare(REF);
      expect(again.token).toBe(rec.token);

      const hit = await share.shareHits(rec.token);
      expect(hit.hits).toBe(1);
      expect(hit.referrerId).toBe(REF);

      expect(await share.referrerOf(rec.token)).toBe(REF);
      await share.revokeShare(REF);
      await expect(share.shareHits(rec.token)).rejects.toMatchObject({ code: 'share.revoked' });
      expect(await share.referrerOf(rec.token)).toBeNull();

      const next = await share.createShare(REF);
      expect(next.token).not.toBe(rec.token);

      await db.sql`UPDATE users SET status = 'closed' WHERE id = ${REF}`;
      await expect(share.shareHits(next.token)).rejects.toMatchObject({ code: 'share.profile_gone' });
    });
  });

  describe('signed share tags (RC-campaigns-06, J-campaigns-05 #2)', () => {
    const KEY = 'TEST-share-tag-key-0123456789abcdef';
    const SESSION_A = 'sessionAAAAAAAAAAAAAAAA';
    const SESSION_B = 'sessionBBBBBBBBBBBBBBBB';
    const tagged = new ShareService(db.sql, { tagKey: KEY, hitsPerIpMinute: 100 });

    it('one session counts once per surface; another session and another surface count apart', async () => {
      await seedUser(REF, 'sharer');
      // A tag never makes a link: the link comes from its own reviewed request.
      await expect(tagged.createTag(REF, 'promotion')).rejects.toMatchObject({ code: 'share.not_found' });
      await tagged.createShare(REF);
      const promo = await tagged.createTag(REF, 'promotion');
      const card = await tagged.createTag(REF, 'card');
      expect(card.token).toBe(promo.token);
      expect(card.tag).not.toBe(promo.tag);

      expect(await tagged.tagHit(promo.tag, SESSION_A, '10.0.0.1')).toMatchObject({ counted: true, visits: 1, surface: 'promotion' });
      expect(await tagged.tagHit(promo.tag, SESSION_A, '10.0.0.1')).toMatchObject({ counted: false, visits: 1 });
      expect(await tagged.tagHit(promo.tag, SESSION_B, '10.0.0.1')).toMatchObject({ counted: true, visits: 2 });
      expect(await tagged.tagHit(card.tag, SESSION_A, '10.0.0.1')).toMatchObject({ counted: true, visits: 1, surface: 'card' });

      const stats = await tagged.surfaceStats(REF);
      expect(stats.token).toBe(promo.token);
      expect(stats.surfaces).toEqual([
        { surface: 'promotion', visits: 2 },
        { surface: 'card', visits: 1 },
        { surface: 'token', visits: 0 },
        { surface: 'strategy', visits: 0 },
        { surface: 'receipt', visits: 0 },
      ]);
    });

    it('a tag whose surface is edited is share.tag_invalid and counts nothing', async () => {
      await seedUser(REF, 'sharer');
      await tagged.createShare(REF);
      const promo = await tagged.createTag(REF, 'promotion');
      const [token, , sig] = promo.tag.split('.');
      await expect(tagged.tagHit(`${token}.card.${sig}`, SESSION_A, '10.0.0.1')).rejects.toMatchObject({ code: 'share.tag_invalid' });
      const rows = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM affiliate_share_hits`;
      expect(rows[0]?.n).toBe(0);
    });

    it('a revoked link is share.revoked; a tag for an unknown token is share.unknown', async () => {
      await seedUser(REF, 'sharer');
      await tagged.createShare(REF);
      const promo = await tagged.createTag(REF, 'promotion');
      await tagged.revokeShare(REF);
      await expect(tagged.tagHit(promo.tag, SESSION_A, '10.0.0.1')).rejects.toMatchObject({ code: 'share.revoked' });
      await expect(tagged.surfaceStats(REF)).rejects.toMatchObject({ code: 'share.not_found' });
    });

    it('no signing key refuses creation share.key_unset; no visit limit keeps the door shut share.rate_unset', async () => {
      await seedUser(REF, 'sharer');
      await tagged.createShare(REF);
      await expect(share.createTag(REF, 'promotion')).rejects.toMatchObject({ code: 'share.key_unset' });
      const promo = await tagged.createTag(REF, 'promotion');
      await expect(share.tagHit(promo.tag, SESSION_A, '10.0.0.1')).rejects.toMatchObject({ code: 'share.rate_unset' });
      const keyless = new ShareService(db.sql, { hitsPerIpMinute: 100 });
      await expect(keyless.tagHit(promo.tag, SESSION_A, '10.0.0.1')).rejects.toMatchObject({ code: 'share.key_unset' });
    });

    it('past the per-IP limit a visit is share.rate_limited and counts nothing', async () => {
      await seedUser(REF, 'sharer');
      const limited = new ShareService(db.sql, { tagKey: KEY, hitsPerIpMinute: 1, now: () => 0 });
      await limited.createShare(REF);
      const promo = await limited.createTag(REF, 'promotion');
      await limited.tagHit(promo.tag, SESSION_A, '10.0.0.9');
      await expect(limited.tagHit(promo.tag, SESSION_B, '10.0.0.9')).rejects.toMatchObject({ code: 'share.rate_limited' });
      expect((await limited.surfaceStats(REF)).surfaces[0]).toEqual({ surface: 'promotion', visits: 1 });
    });
  });
}
