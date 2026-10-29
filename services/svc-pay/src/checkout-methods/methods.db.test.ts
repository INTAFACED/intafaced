import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import type { CheckoutMethodRule, Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { MethodRails } from './catalogue.js';
import { checkoutMethodFor } from './methods.js';
import { createCheckoutMethodsRouter } from './router.js';

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
    .withDatabase('intafaced_checkout_methods_test')
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
    const err = error as { code?: string; cause?: { code?: string }; detail?: unknown };
    return { code: err.code, cause: err.cause?.code, detail: err.detail };
  }
  throw new Error('expected a refusal');
}

/** The platform as the local stack has it: the crypto rail everywhere, nothing else. */
const CRYPTO_ONLY: MethodRails = new Map([['crypto', { countries: ['*'] }]]);
/** A platform with a card rail for two countries beside the crypto rail. TEST profiles. */
const WITH_CARD: MethodRails = new Map([
  ['crypto', { countries: ['*'] }],
  ['card', { countries: ['DE', 'FR'] }],
]);

const rule = (method: CheckoutMethodRule['method'], enabled: boolean, over: Partial<CheckoutMethodRule> = {}): CheckoutMethodRule => ({
  method,
  enabled,
  ruleAsset: null,
  minAmount: null,
  maxAmount: null,
  ...over,
});

describe('the payment methods a hosted checkout offers (M-adv-payments-core-11, J-merchant-04 step 7)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const otherOwner = nid();
  const viewer = nid();
  const admin = nid();
  let merchant = '';
  let otherMerchant = '';
  let rails: MethodRails = CRYPTO_ONLY;

  const as = (userId: string, over: Partial<Principal> = {}) =>
    createCheckoutMethodsRouter({ sql, rails: () => rails }).createCaller(ctxOf(principalOf(userId, over)));

  const link = async (
    merchantId: string,
    amount: string | null,
    currency: string | null,
    over: { active?: boolean; expiresAt?: Date } = {},
  ) => {
    const token = `pl_${nid()}`;
    await sql`
      INSERT INTO pay.payment_links (merchant_id, token_hash, token_prefix, label, amount, currency, active, expires_at)
      VALUES (${merchantId}, ${createHash('sha256').update(token).digest('hex')}, ${token.slice(0, 8)}, 'TEST link', ${amount},
              ${currency}, ${over.active ?? true}, ${over.expiresAt ?? null})`;
    return token;
  };

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
    otherMerchant = (
      await sql<
        Array<{ id: string }>
      >`INSERT INTO pay.merchants (user_id, kyb_status, status) VALUES (${otherOwner}, 'approved', 'active') RETURNING id`
    )[0]!.id;
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchant}, ${viewer}, 'viewer', 'active', ${owner}, now()),
             (${merchant}, ${admin}, 'admin', 'active', ${owner}, now())`;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('starts at the default: the catalogue order, only connected methods on, and the rest naming what they need', async () => {
    expect(await as(viewer).merchantCheckoutMethods.get({})).toEqual({
      status: 'default',
      version: 0,
      updatedAt: null,
      methods: [
        { rule: rule('crypto', true), connection: { state: 'connected' }, currencies: 'crypto' },
        { rule: rule('card', false), connection: { state: 'not_connected', notice: 'rail.card' }, currencies: 'fiat' },
        { rule: rule('bank_debit', false), connection: { state: 'not_connected', notice: 'rail.bank' }, currencies: 'fiat' },
        { rule: rule('pay_later', false), connection: { state: 'not_connected', notice: 'rail.card' }, currencies: 'fiat' },
        { rule: rule('bank_transfer', false), connection: { state: 'not_connected', notice: 'rail.bank' }, currencies: 'fiat' },
      ],
    });
    expect(await as(viewer).merchantCheckoutMethods.preview({ country: 'de', currency: 'usdt' })).toEqual({
      offered: [{ method: 'crypto', connection: { state: 'connected' } }],
      leftOut: [
        { method: 'card', reason: 'off' },
        { method: 'bank_debit', reason: 'off' },
        { method: 'pay_later', reason: 'off' },
        { method: 'bank_transfer', reason: 'off' },
      ],
    });
  });

  it('saves the order once per request; the preview offers in that order with bank debit naming rail.bank', async () => {
    const methods = [
      rule('bank_debit', true),
      rule('crypto', true),
      rule('card', true),
      rule('pay_later', false),
      rule('bank_transfer', false),
    ];
    const input = { requestId: nid(), expectedVersion: 0, methods };
    const saved = await as(owner).merchantCheckoutMethods.save(input);
    expect(saved.replayed).toBe(false);
    expect(saved.methods).toMatchObject({ status: 'saved', version: 1 });
    expect(saved.methods.methods.map((m) => m.rule.method)).toEqual(['bank_debit', 'crypto', 'card', 'pay_later', 'bank_transfer']);
    expect(await as(owner).merchantCheckoutMethods.save(input)).toEqual({ methods: saved.methods, replayed: true });
    expect((await refusal(() => as(owner).merchantCheckoutMethods.save({ ...input, methods: [...methods].reverse() }))).cause).toBe(
      'pay.request_id_reused',
    );
    expect(await as(viewer).merchantCheckoutMethods.preview({ country: 'DE', currency: 'EUR' })).toEqual({
      offered: [
        { method: 'bank_debit', connection: { state: 'not_connected', notice: 'rail.bank' } },
        { method: 'card', connection: { state: 'not_connected', notice: 'rail.card' } },
      ],
      leftOut: [
        { method: 'crypto', reason: 'currency' },
        { method: 'pay_later', reason: 'off' },
        { method: 'bank_transfer', reason: 'off' },
      ],
    });
    expect((await as(viewer).merchantCheckoutMethods.preview({ country: 'DE', currency: 'USDT' })).offered).toEqual([
      { method: 'crypto', connection: { state: 'connected' } },
    ]);
    // Another business still has the default.
    expect((await as(otherOwner).merchantCheckoutMethods.get({})).status).toBe('default');
  });

  it('applies a minimum and maximum only to a payment in their asset, and a connected rail only in its countries', async () => {
    const current = await as(owner).merchantCheckoutMethods.get({});
    await as(owner).merchantCheckoutMethods.save({
      requestId: nid(),
      expectedVersion: current.version,
      methods: [
        rule('crypto', true, { ruleAsset: 'usdt', minAmount: '10', maxAmount: '500.5' }),
        rule('card', true),
        rule('bank_debit', false),
        rule('pay_later', false),
        rule('bank_transfer', false),
      ],
    });
    rails = WITH_CARD;
    try {
      const preview = (country: string, currency: string, amount?: string) =>
        as(viewer).merchantCheckoutMethods.preview({ country, currency, ...(amount ? { amount } : {}) });
      expect((await preview('DE', 'USDT', '9.99')).leftOut).toContainEqual({ method: 'crypto', reason: 'below_min' });
      expect((await preview('DE', 'USDT', '500.6')).leftOut).toContainEqual({ method: 'crypto', reason: 'above_max' });
      expect((await preview('DE', 'USDT', '500.5')).offered).toEqual([{ method: 'crypto', connection: { state: 'connected' } }]);
      // A rule in USDT says nothing about a USDC payment.
      expect((await preview('DE', 'USDC', '1')).offered).toEqual([{ method: 'crypto', connection: { state: 'connected' } }]);
      expect((await preview('FR', 'EUR')).offered).toEqual([{ method: 'card', connection: { state: 'connected' } }]);
      expect((await preview('US', 'EUR')).leftOut).toContainEqual({ method: 'card', reason: 'country' });
    } finally {
      rails = CRYPTO_ONLY;
    }
  });

  it('refuses a stale save, an inverted rule, a missing method, and a save from anyone but the owner and admins', async () => {
    const current = await as(admin).merchantCheckoutMethods.get({});
    const methods = current.methods.map((m) => m.rule);
    expect((await refusal(() => as(admin).merchantCheckoutMethods.save({ requestId: nid(), expectedVersion: 0, methods }))).cause).toBe(
      'pay.checkout_methods_stale',
    );
    const inverted = [rule('crypto', true, { ruleAsset: 'USDT', minAmount: '100', maxAmount: '99.999' }), ...methods.slice(1)];
    expect(
      (
        await refusal(() =>
          as(admin).merchantCheckoutMethods.save({ requestId: nid(), expectedVersion: current.version, methods: inverted }),
        )
      ).cause,
    ).toBe('pay.checkout_method_rule_inverted');
    // Ten and nine: compared as decimals, not as text.
    const tenNine = [rule('crypto', true, { ruleAsset: 'USDT', minAmount: '9', maxAmount: '10' }), ...methods.slice(1)];
    expect(
      (await as(admin).merchantCheckoutMethods.save({ requestId: nid(), expectedVersion: current.version, methods: tenNine })).methods
        .version,
    ).toBe(current.version + 1);
    expect(
      await refusal(() =>
        as(admin).merchantCheckoutMethods.save({
          requestId: nid(),
          expectedVersion: 0,
          methods: [methods[0]!, methods[0]!, methods[1]!, methods[2]!, methods[3]!],
        }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      await refusal(() =>
        as(admin).merchantCheckoutMethods.save({
          requestId: nid(),
          expectedVersion: 0,
          methods: [rule('crypto', true, { minAmount: '1' }), ...methods.slice(1)],
        }),
      ),
    ).toMatchObject({ code: 'BAD_REQUEST' });
    const save = (who: string, over: Partial<Principal> = {}) =>
      refusal(() => as(who, over).merchantCheckoutMethods.save({ requestId: nid(), expectedVersion: 99, methods }));
    expect(await save(viewer)).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    expect(await save(owner, { mfa: false })).toMatchObject({ code: 'FORBIDDEN' });
    expect(await refusal(() => as(nid()).merchantCheckoutMethods.get({}))).toMatchObject({ code: 'FORBIDDEN' });
    const err = await sql`DELETE FROM pay.checkout_method_saves WHERE merchant_id = ${merchant}`.catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('23001');
  });

  it('reads a saved row that no longer parses as the default, never as a guess', async () => {
    await sql`
      INSERT INTO pay.checkout_methods (merchant_id, methods, updated_by)
      VALUES (${otherMerchant}, ${sql.json([{ method: 'cheque', enabled: true }] as never)}, ${otherOwner})`;
    const read = await as(otherOwner).merchantCheckoutMethods.get({});
    // Its version stays, so the next save replaces it; it was not saved as the methods in force, so there is no date.
    expect(read).toMatchObject({ status: 'default', version: 1, updatedAt: null });
    expect(read.methods.map((m) => [m.rule.method, m.rule.enabled])).toEqual([
      ['crypto', true],
      ['card', false],
      ['bank_debit', false],
      ['pay_later', false],
      ['bank_transfer', false],
    ]);
    await sql`DELETE FROM pay.checkout_methods WHERE merchant_id = ${otherMerchant}`;
  });

  describe('the method a hosted checkout opens with', () => {
    const now = new Date();
    const setMethods = async (methods: CheckoutMethodRule[]) => {
      const current = await as(owner).merchantCheckoutMethods.get({});
      await as(owner).merchantCheckoutMethods.save({ requestId: nid(), expectedVersion: current.version, methods });
    };

    it('passes the caller through for a business that never saved, so the open runs as before', async () => {
      const token = await link(otherMerchant, '5', 'EUR');
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: token, geoCountry: 'DE' }, now)).toBeUndefined();
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: token, geoCountry: 'DE', method: 'card' }, now)).toBe('card');
    });

    it('for a business that never saved and whose category leaves one method, the default offer decides', async () => {
      const limited = { categoryLimited: true };
      // The one method the category allows, for a payment it can take; never a blank method routing would refuse.
      const usdt = await link(otherMerchant, '5', 'USDT');
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: usdt, geoCountry: 'DE' }, now, limited)).toBe('crypto');
      // Euros the category's one method cannot take refuse by name, not as a crypto payment for euros.
      const eur = await link(otherMerchant, '5', 'EUR');
      await expect(checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: eur, geoCountry: 'DE' }, now, limited)).rejects.toMatchObject({
        code: 'pay.checkout_no_method',
      });
      // A country the offer cannot read refuses as a missing country, as for a saved offer.
      await expect(checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: usdt, geoCountry: 'Germany' }, now, limited)).rejects.toMatchObject({
        code: 'pay.routing_input_missing',
      });
    });

    it('takes the only payable method; bank debit first and on still pays a USDT link by crypto', async () => {
      await setMethods([
        rule('bank_debit', true),
        rule('crypto', true),
        rule('card', false),
        rule('pay_later', false),
        rule('bank_transfer', false),
      ]);
      const token = await link(merchant, '100', 'USDT');
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: token, geoCountry: 'de' }, now)).toBe('crypto');
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: token, geoCountry: 'DE', method: 'crypto' }, now)).toBe('crypto');
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: token, geoCountry: 'DE', method: ' Crypto' }, now)).toBe('crypto');
      // A country the offer cannot read does not skip the rules.
      expect(
        await refusal(() => checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: token, geoCountry: 'XXX', method: 'card' }, now)),
      ).toMatchObject({ code: 'pay.routing_input_missing', detail: { missing: ['geo'] } });
      const notOffered = await refusal(() =>
        checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: token, geoCountry: 'DE', method: 'card' }, now),
      );
      expect(notOffered).toMatchObject({ code: 'pay.checkout_method_not_offered' });
    });

    it('refuses a fiat payment with no connected method, naming rail.bank, and asks for a choice between two', async () => {
      const eur = await link(merchant, '25', 'EUR');
      expect(await refusal(() => checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: eur, geoCountry: 'DE' }, now))).toMatchObject({
        code: 'pay.checkout_no_method',
        detail: { offer: { offered: [{ method: 'bank_debit', connection: { state: 'not_connected', notice: 'rail.bank' } }] } },
      });
      await setMethods([
        rule('card', true),
        rule('bank_debit', true),
        rule('crypto', true),
        rule('pay_later', true),
        rule('bank_transfer', false),
      ]);
      const both: MethodRails = new Map([...WITH_CARD, ['pay_later', { countries: ['DE'] }]]);
      expect(await refusal(() => checkoutMethodFor(sql, both, { linkToken: eur, geoCountry: 'DE' }, now))).toMatchObject({
        code: 'pay.checkout_method_required',
        detail: {
          offer: {
            offered: [
              { method: 'card', connection: { state: 'connected' } },
              { method: 'bank_debit', connection: { state: 'not_connected', notice: 'rail.bank' } },
              { method: 'pay_later', connection: { state: 'connected' } },
            ],
          },
        },
      });
      expect(await checkoutMethodFor(sql, both, { linkToken: eur, geoCountry: 'DE', method: 'pay_later' }, now)).toBe('pay_later');
      // Outside the card rails' countries nothing payable is left.
      expect(await refusal(() => checkoutMethodFor(sql, both, { linkToken: eur, geoCountry: 'US' }, now))).toMatchObject({
        code: 'pay.checkout_no_method',
        detail: {
          offer: {
            leftOut: [
              { method: 'card', reason: 'country' },
              { method: 'crypto', reason: 'currency' },
              { method: 'pay_later', reason: 'country' },
              { method: 'bank_transfer', reason: 'off' },
            ],
          },
        },
      });
    });

    it('applies the rule to the payer amount on a link with no amount, and leaves the rest to the open', async () => {
      await setMethods([
        rule('crypto', true, { ruleAsset: 'USDT', minAmount: '10', maxAmount: null }),
        rule('card', false),
        rule('bank_debit', false),
        rule('pay_later', false),
        rule('bank_transfer', false),
      ]);
      const open = await link(merchant, null, 'USDT');
      expect(
        await refusal(() => checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: open, geoCountry: 'DE', amount: parseAmount('9') }, now)),
      ).toMatchObject({
        code: 'pay.checkout_no_method',
        detail: { offer: { leftOut: expect.arrayContaining([{ method: 'crypto', reason: 'below_min' }]) } },
      });
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: open, geoCountry: 'DE', amount: parseAmount('10') }, now)).toBe(
        'crypto',
      );
      // No country, no currency, a link that cannot be paid, or no connected method: the open refuses those by name.
      const noCurrency = await link(merchant, null, null);
      const off = await link(merchant, '1', 'EUR', { active: false });
      const expired = await link(merchant, '1', 'EUR', { expiresAt: new Date(now.getTime() - 1000) });
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: open }, now)).toBeUndefined();
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: noCurrency, geoCountry: 'DE' }, now)).toBeUndefined();
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: off, geoCountry: 'DE' }, now)).toBeUndefined();
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: expired, geoCountry: 'DE' }, now)).toBeUndefined();
      expect(await checkoutMethodFor(sql, CRYPTO_ONLY, { linkToken: 'pl_nothing', geoCountry: 'DE' }, now)).toBeUndefined();
      expect(await checkoutMethodFor(sql, new Map(), { linkToken: open, geoCountry: 'DE', amount: parseAmount('1') }, now)).toBeUndefined();
    });
  });
});
