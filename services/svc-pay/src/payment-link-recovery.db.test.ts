import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { teamReadFromSql } from './merchant-team-read.js';
import { PayService } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';
import { createPayRouter } from './router.js';
import { UserMoneyService } from './user-money-service.js';

/**
 * A lost createLink reply must not mint a second checkout address, and the
 * owner must be able to read the original address again.
 *
 * The token is the checkout credential. Public resolve still hashes it.
 * Stored roles are not the owner: the role table has no link permission, and
 * list/get stay on the owner / PayFac gate.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const FINANCE = '55555555-5555-4555-8555-555555555555';
const DEVELOPER = '66666666-6666-4666-8666-666666666666';
const STRANGER = '77777777-7777-4777-8777-777777777777';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_pay_link_recovery_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

async function ctx(scopes: string[], userId: string): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: randomUUID(), scopes, tier: 'full', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: randomUUID() };
}

function payCode(err: unknown): string | undefined {
  return /pay\.[a-z0-9_.]+/.exec((err as { message?: string }).message ?? '')?.[0];
}

describe('payment link checkout recovery', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let router!: ReturnType<typeof createPayRouter>;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.merchants RESTART IDENTITY CASCADE');
    const ledger = new MemoryLedger();
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: 'svc-pay-test-secret-at-least-32-characters', toleranceSeconds: 300 }),
    ]);
    pay = new PayService(sql, ledger, rails, {
      checkoutRiskBand: 'low',
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
      checkoutPublicBasePath: '/api/pay',
    });
    router = createPayRouter(
      pay,
      rails,
      new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [] }),
      null,
      undefined,
      undefined,
      teamReadFromSql(sql),
    );
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant(userId: string) {
    return pay.createMerchant({ userId, pricing: { feeBps: 250 } });
  }

  async function member(merchantId: string, userId: string, role: string) {
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${userId}, ${role}, 'active', ${OWNER}, now())`;
  }

  const body = (merchantId: string) => ({
    merchantId,
    label: 'Invoice 7',
    amount: parseAmount('12.50'),
    currency: 'USDT',
    maxUses: 1,
    idempotencyKey: 'link:invoice:7',
  });

  it('replays the same key and body as the original checkout address', async () => {
    const mine = await merchant(OWNER);
    const first = await pay.createPaymentLink(body(mine.id));
    const retry = await pay.createPaymentLink({ ...body(mine.id), idempotencyKey: '  link:invoice:7  ' });

    expect(retry).toEqual(first);
    expect(retry.token.startsWith('pl_')).toBe(true);
    expect(retry.checkoutUrl).toBe(`/api/pay/checkout?token=${encodeURIComponent(retry.token)}`);
    expect(await pay.resolvePaymentLink(retry.token)).toMatchObject({ id: first.id, label: 'Invoice 7' });
    expect(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pay.payment_links WHERE merchant_id = ${mine.id}`).toEqual([{ n: 1 }]);
    expect(
      await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pay.payment_link_create_idempotency
         WHERE merchant_id = ${mine.id} AND link_id = ${first.id}
      `,
    ).toEqual([{ n: 1 }]);
  });

  it('refuses the same key with a different body and keeps the original address', async () => {
    const mine = await merchant(OWNER);
    const first = await pay.createPaymentLink(body(mine.id));
    await expect(pay.createPaymentLink({ ...body(mine.id), label: 'Other invoice' })).rejects.toMatchObject({
      code: 'pay.idempotency_conflict',
    });
    const again = await pay.createPaymentLink(body(mine.id));
    expect(again.token).toBe(first.token);
    expect(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pay.payment_links WHERE merchant_id = ${mine.id}`).toEqual([{ n: 1 }]);
  });

  it('does not consume the key when the create rolls back', async () => {
    const mine = await merchant(OWNER);
    await expect(
      pay.createPaymentLink({ ...body(mine.id), profileId: randomUUID(), idempotencyKey: 'link:profile' }),
    ).rejects.toMatchObject({ code: 'pay.profile_not_found' });
    const created = await pay.createPaymentLink({ ...body(mine.id), idempotencyKey: 'link:profile' });
    expect(created.id).toEqual(expect.any(String));
    expect(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pay.payment_links WHERE merchant_id = ${mine.id}`).toEqual([{ n: 1 }]);
  });

  it('two concurrent creates with one key leave one link', async () => {
    const mine = await merchant(OWNER);
    const [a, b] = await Promise.all([
      pay.createPaymentLink({ ...body(mine.id), idempotencyKey: 'link:race' }),
      pay.createPaymentLink({ ...body(mine.id), idempotencyKey: 'link:race' }),
    ]);
    expect(b).toEqual(a);
    expect(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pay.payment_links WHERE merchant_id = ${mine.id}`).toEqual([{ n: 1 }]);
  });

  it('a key does not cross merchants, and a missing key mints again', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(OTHER);
    const a = await pay.createPaymentLink(body(mine.id));
    const b = await pay.createPaymentLink(body(other.id));
    expect(b.token).not.toBe(a.token);
    const third = await pay.createPaymentLink({ merchantId: mine.id, label: 'Invoice 7' });
    expect(third.id).not.toBe(a.id);
  });

  it('refuses a blank key before a row exists', async () => {
    const mine = await merchant(OWNER);
    await expect(pay.createPaymentLink({ merchantId: mine.id, label: 'Invoice', idempotencyKey: '   ' })).rejects.toMatchObject({
      code: 'pay.idempotency_required',
    });
    expect(await sql`SELECT id FROM pay.payment_links WHERE merchant_id = ${mine.id}`).toHaveLength(0);
    expect(await sql`SELECT idempotency_key FROM pay.payment_link_create_idempotency WHERE merchant_id = ${mine.id}`).toHaveLength(0);
  });

  it('replays a stored link after the merchant is suspended, and refuses a new one', async () => {
    const mine = await merchant(OWNER);
    const first = await pay.createPaymentLink(body(mine.id));
    await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${mine.id}`;
    expect(await pay.createPaymentLink(body(mine.id))).toMatchObject({ id: first.id, token: first.token });
    await expect(pay.createPaymentLink({ ...body(mine.id), idempotencyKey: 'link:new' })).rejects.toMatchObject({
      code: 'pay.merchant_inactive',
    });
  });

  it('lets the owner re-read the checkout path, and a link without a stored token stays null', async () => {
    const mine = await merchant(OWNER);
    const created = await pay.createPaymentLink(body(mine.id));
    const token = 'pl_legacytokenvalue';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [legacy] = await sql<{ id: string }[]>`
      INSERT INTO pay.payment_links (merchant_id, token_hash, token_prefix, label, expires_at)
      VALUES (${mine.id}, ${tokenHash}, 'pl_legacyt', 'Old', now() + interval '2 days')
      RETURNING id`;

    const owner = router.createCaller(await ctx(['pay:read'], OWNER));
    const page = await owner.merchant.listLinks({ merchantId: mine.id, limit: 10 });
    const listed = page.items.find((item) => item.id === created.id);
    expect(listed).toMatchObject({ token: created.token, checkoutUrl: created.checkoutUrl });
    const detail = await owner.merchant.getLink({ merchantId: mine.id, linkId: created.id });
    expect(detail).toMatchObject({ token: created.token, checkoutUrl: created.checkoutUrl });

    const old = page.items.find((item) => item.id === legacy!.id);
    expect(old).toMatchObject({ token: null, checkoutUrl: null, prefix: 'pl_legacyt' });
    expect(await owner.merchant.getLink({ merchantId: mine.id, linkId: legacy!.id })).toMatchObject({
      token: null,
      checkoutUrl: null,
    });
    expect(await pay.resolvePaymentLink(token)).toMatchObject({ id: legacy!.id, label: 'Old' });
    await expect(pay.resolvePaymentLink('pl_legacyt')).rejects.toMatchObject({ code: 'pay.link_not_found' });
  });

  it('refuses a foreign merchant and every stored role the same way, without the checkout token', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(OTHER);
    const created = await pay.createPaymentLink(body(mine.id));
    await member(mine.id, VIEWER, 'viewer');
    await member(mine.id, ADMIN, 'admin');
    await member(mine.id, FINANCE, 'finance');
    await member(mine.id, DEVELOPER, 'developer');

    const owner = router.createCaller(await ctx(['pay:read'], OWNER));
    const stranger = router.createCaller(await ctx(['pay:read'], STRANGER));
    const foreign = router.createCaller(await ctx(['pay:read', 'pay:write'], OTHER));
    const missingMerchant = randomUUID();
    const missingLink = randomUUID();

    const strangerList = await stranger.merchant.listLinks({ merchantId: mine.id, limit: 10 }).catch((err: unknown) => err);
    const foreignList = await foreign.merchant.listLinks({ merchantId: mine.id, limit: 10 }).catch((err: unknown) => err);
    const missingList = await owner.merchant.listLinks({ merchantId: missingMerchant, limit: 10 }).catch((err: unknown) => err);
    expect(payCode(strangerList)).toBe('pay.merchant_not_found');
    expect(payCode(foreignList)).toBe(payCode(missingList));
    expect(JSON.stringify(foreignList)).not.toContain(created.token);

    const foreignGet = await foreign.merchant.getLink({ merchantId: mine.id, linkId: created.id }).catch((err: unknown) => err);
    const missingGet = await owner.merchant.getLink({ merchantId: missingMerchant, linkId: missingLink }).catch((err: unknown) => err);
    expect(payCode(foreignGet)).toBe(payCode(missingGet));
    expect(JSON.stringify(foreignGet)).not.toContain(created.token);

    const wrongLink = await foreign.merchant.getLink({ merchantId: other.id, linkId: created.id }).catch((err: unknown) => err);
    const absentLink = await foreign.merchant.getLink({ merchantId: other.id, linkId: missingLink }).catch((err: unknown) => err);
    expect(payCode(wrongLink)).toBe('pay.link_not_found');
    expect(payCode(wrongLink)).toBe(payCode(absentLink));
    expect(JSON.stringify(wrongLink)).not.toContain(created.token);

    for (const userId of [VIEWER, ADMIN, FINANCE, DEVELOPER]) {
      const caller = router.createCaller(await ctx(['pay:read', 'pay:write'], userId));
      const listed = await caller.merchant.listLinks({ merchantId: mine.id, limit: 10 }).catch((err: unknown) => err);
      const got = await caller.merchant.getLink({ merchantId: mine.id, linkId: created.id }).catch((err: unknown) => err);
      expect(payCode(listed)).toBe('pay.merchant_not_found');
      expect(payCode(got)).toBe(payCode(strangerList));
      expect(JSON.stringify(listed)).not.toContain(created.token);
      expect(JSON.stringify(got)).not.toContain(created.token);
    }

    expect((await owner.merchant.listLinks({ merchantId: mine.id, limit: 10 })).items.map((item) => item.token)).toContain(created.token);
    expect((await foreign.merchant.listLinks({ merchantId: other.id, limit: 10 })).items).toEqual([]);
  });
});
