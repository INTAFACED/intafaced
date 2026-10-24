import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createCheckoutBrandingRouter } from './router.js';
import { checkoutLookOf } from './branding.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_checkout_branding_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const nid = () => randomUUID();
const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: nid(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: nid(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    return { code: err.code, cause: err.cause?.code };
  }
  throw new Error('expected a refusal');
}

/** A 1x1 PNG (70 bytes): the smallest real image. TEST bytes. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** The first bytes of a JPEG. TEST bytes. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

describe('the hosted checkout look (M-payments-core-08, J-merchant-04 step 1)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const otherOwner = nid();
  const viewer = nid();
  const admin = nid();
  let merchant = '';

  const as = (userId: string, over: Partial<Principal> = {}, maxBytes: number | null = 100) =>
    createCheckoutBrandingRouter({ sql, logoRule: { maxBytes } }).createCaller(ctxOf(principalOf(userId, over)));

  beforeAll(async () => {
    const opened = await openAdmin();
    adminStop = opened.stop;
    db = await createTestDatabase({ service: 'pay', url: opened.url, migrations });
    sql = db.sql;
    merchant = (
      await sql<
        Array<{ id: string }>
      >`INSERT INTO pay.merchants (user_id, kyb_status, status) VALUES (${owner}, 'approved', 'active') RETURNING id`
    )[0]!.id;
    await sql`INSERT INTO pay.merchants (user_id, kyb_status, status) VALUES (${otherOwner}, 'approved', 'active')`;
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchant}, ${viewer}, 'viewer', 'active', ${owner}, now()),
             (${merchant}, ${admin}, 'admin', 'active', ${owner}, now())`;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('starts at the default look with the published logo rule, and saves a colour and logo once per request', async () => {
    expect(await as(viewer).merchantCheckout.branding.get({})).toEqual({
      rules: { logoMaxBytes: 100, logoTypes: ['image/png', 'image/jpeg', 'image/webp'] },
      look: { status: 'default' },
    });
    const input = { requestId: nid(), expectedVersion: 0, brandColor: '#FF6600', logo: { contentType: 'image/png', dataBase64: PNG } };
    const saved = await as(owner).merchantCheckout.branding.save(input);
    expect(saved.replayed).toBe(false);
    expect(saved.branding.look).toMatchObject({
      status: 'saved',
      brandColor: '#ff6600',
      version: 1,
      logo: { contentType: 'image/png', byteSize: 70, dataBase64: PNG },
    });
    expect(await as(owner).merchantCheckout.branding.save(input)).toEqual({ branding: saved.branding, replayed: true });
    expect((await refusal(() => as(owner).merchantCheckout.branding.save({ ...input, brandColor: '#000000' }))).cause).toBe(
      'pay.request_id_reused',
    );
    expect((await as(viewer).merchantCheckout.branding.get({})).look).toEqual(saved.branding.look);
    // Another business still has the default look.
    expect((await as(otherOwner).merchantCheckout.branding.get({})).look).toEqual({ status: 'default' });
  });

  it('keeps the logo when a save leaves it out, takes it off with null, and refuses a save from an older version', async () => {
    const before = await as(admin).merchantCheckout.branding.get({});
    if (before.look.status !== 'saved') throw new Error('expected the saved look');
    const kept = await as(admin).merchantCheckout.branding.save({
      requestId: nid(),
      expectedVersion: before.look.version,
      brandColor: '#0b1f3a',
    });
    expect(kept.branding.look).toMatchObject({ brandColor: '#0b1f3a', version: before.look.version + 1, logo: { byteSize: 70 } });
    expect(
      (
        await refusal(() =>
          as(owner).merchantCheckout.branding.save({ requestId: nid(), expectedVersion: before.look.version, brandColor: '#111111' }),
        )
      ).cause,
    ).toBe('pay.checkout_branding_stale');
    const off = await as(owner).merchantCheckout.branding.save({
      requestId: nid(),
      expectedVersion: before.look.version + 1,
      brandColor: '#0b1f3a',
      logo: null,
    });
    expect(off.branding.look).toMatchObject({ logo: null, version: before.look.version + 2 });
  });

  it('recognises a retried save after later saves, and answers with the look as it is now', async () => {
    const before = await as(owner).merchantCheckout.branding.get({});
    const version = before.look.status === 'saved' ? before.look.version : 0;
    const first = { requestId: nid(), expectedVersion: version, brandColor: '#222222' };
    await as(owner).merchantCheckout.branding.save(first);
    const later = await as(admin).merchantCheckout.branding.save({ requestId: nid(), expectedVersion: version + 1, brandColor: '#333333' });
    // The owner's answer was lost and it sends the same save again: it was made, so it is not refused as stale.
    expect(await as(owner).merchantCheckout.branding.save(first)).toEqual({ branding: later.branding, replayed: true });
    expect((await refusal(() => as(owner).merchantCheckout.branding.save({ ...first, brandColor: '#444444' }))).cause).toBe(
      'pay.request_id_reused',
    );
    const [logged] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.checkout_branding_saves WHERE merchant_id = ${merchant} AND request_id = ${first.requestId}::uuid`;
    expect(logged!.n).toBe(1);
    const err = await sql`DELETE FROM pay.checkout_branding_saves WHERE merchant_id = ${merchant}`.catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('23001');
  });

  it('refuses a logo over the rule, one whose bytes are not the type it claims, and any logo while no size is published', async () => {
    const current = await as(owner).merchantCheckout.branding.get({});
    const version = current.look.status === 'saved' ? current.look.version : 0;
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(40)]).toString('base64');
    const save = (logo: { contentType: string; dataBase64: string }, maxBytes: number | null = 100) =>
      refusal(() =>
        as(owner, {}, maxBytes).merchantCheckout.branding.save({ requestId: nid(), expectedVersion: version, brandColor: '#123456', logo }),
      );
    expect((await save({ contentType: 'image/png', dataBase64: big })).cause).toBe('pay.checkout_logo_too_large');
    expect((await save({ contentType: 'image/png', dataBase64: JPEG })).cause).toBe('pay.checkout_logo_type_refused');
    expect((await save({ contentType: 'image/gif', dataBase64: Buffer.from('GIF89a').toString('base64') })).cause).toBe(
      'pay.checkout_logo_type_refused',
    );
    expect((await save({ contentType: 'image/png', dataBase64: 'not base64!' })).cause).toBe('pay.checkout_logo_unreadable');
    expect((await save({ contentType: 'image/png', dataBase64: PNG }, null)).cause).toBe('pay.checkout_logo_rules_unset');
    // A colour alone saves while no size is published.
    const colour = await as(owner, {}, null).merchantCheckout.branding.save({
      requestId: nid(),
      expectedVersion: version,
      brandColor: '#123456',
    });
    expect(colour.branding).toMatchObject({ rules: { logoMaxBytes: null }, look: { brandColor: '#123456' } });
    expect(
      await refusal(() =>
        as(owner).merchantCheckout.branding.save({ requestId: nid(), expectedVersion: version + 1, brandColor: 'orange' }),
      ),
    ).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('lets only the owner and admins save, from a session with a second factor', async () => {
    const save = (who: string, over: Partial<Principal> = {}) =>
      refusal(() => as(who, over).merchantCheckout.branding.save({ requestId: nid(), expectedVersion: 99, brandColor: '#123456' }));
    expect(await save(viewer)).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    expect(await save(owner, { mfa: false })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await refusal(() => as(nid()).merchantCheckout.branding.get({}))).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('gives the hosted page the saved look for every link of the business', async () => {
    const [row] = await sql<Array<{ brand_color: string; logo_type: string | null; logo_bytes: Buffer | null }>>`
      SELECT brand_color, logo_type, logo_bytes FROM pay.checkout_branding WHERE merchant_id = ${merchant}`;
    expect(checkoutLookOf(row!)).toMatchObject({ brandColor: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    const err = await sql`UPDATE pay.checkout_branding SET brand_color = 'red' WHERE merchant_id = ${merchant}`.catch(
      (e: { code?: string }) => e,
    );
    expect((err as { code?: string }).code).toBe('23514');
  });
});
