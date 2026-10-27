import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvertiserTermsAcceptances, advertiserTermsVersion, createAdvertiserTerms } from './advertiser-terms.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pError, P2pService } from './p2p-service.js';
import { createP2pRouter } from './router.js';

/**
 * P-ads-merchant-01 / J-p2p-03 #2, #4, #6: a new ad needs the published advertiser terms accepted, a sell ad's total
 * may not exceed the maker's free balance, nothing is reserved at post, and a retry with the same key answers the
 * same ad even after the balance or the terms moved.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const VERSION = 'TEST-v1';
const SECRET = 'p2p-advertiser-terms-edge-secret-long';

describe('svc-p2p advertiser terms and the sell balance at post (P-ads-merchant-01)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let instruments!: InstrumentService;
  let ledger!: MemoryLedger;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    instruments = new InstrumentService(sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    await instruments.createInstrument({
      ownerId: MAKER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa',
      details: { account_reference: 'ref-maker' },
      instrumentId: crypto.randomUUID(),
    });
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${MAKER}:fund` }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function service(version: string | null = VERSION) {
    return new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      advertiserTerms: createAdvertiserTerms({ acceptances: new AdvertiserTermsAcceptances(sql), version }),
      sellBalanceAtPost: true,
    });
  }

  function caller(p2p: P2pService, options: { userId?: string; kid?: string } = {}) {
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'none');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture:p2p-advertiser-terms');
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'false');
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-p2p' });
    const userId = options.userId ?? MAKER;
    const principal = {
      sub: userId,
      userId,
      sid: '55555555-5555-4555-8555-555555555555',
      scopes: ['p2p:read', 'p2p:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
      ...(options.kid ? { kid: options.kid } : {}),
    } as Principal;
    const raw = encodePrincipal(principal);
    return createP2pRouter(p2p, instruments, undefined, { instrumentKeyProvider: 'local-test' }).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-advertiser-terms',
      }),
    );
  }

  // Each ad names its own id, and its key is that id, as the form sends them.
  let adNumber = 0;
  const adId = () => `a0000000-0000-4000-8000-${String(++adNumber).padStart(12, '0')}`;
  const sellAd = (extra: Record<string, unknown> = {}, offerId = adId()) => ({
    side: 'sell' as const,
    asset: ASSET,
    fiatCurrency: 'EUR',
    priceType: 'fixed' as const,
    price: '0.93',
    minAmount: '10',
    maxAmount: '50',
    totalAmount: '100',
    methods: ['sepa'],
    terms: 'TEST terms',
    offerId,
    idempotencyKey: `p2p:offer-create:${offerId}`,
    ...extra,
  });

  const offers = async () => sql<{ id: string }[]>`SELECT id FROM p2p.offers`;

  it('refuses a post until the published terms are accepted, then the same post makes one ad', async () => {
    const c = caller(service());
    expect(await c.merchants.advertiserTerms()).toEqual({ version: VERSION, acceptedAt: null });
    const ad = sellAd({ advertiserTermsVersion: VERSION });
    await expect(c.offers.create(ad)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'p2p.terms_not_accepted' }),
    });
    expect(await offers()).toHaveLength(0);

    const accepted = await c.merchants.acceptAdvertiserTerms({ version: VERSION });
    expect(accepted.version).toBe(VERSION);
    // Accepting again keeps the first acceptance.
    expect(await c.merchants.acceptAdvertiserTerms({ version: VERSION })).toEqual(accepted);
    expect(await c.merchants.advertiserTerms()).toEqual(accepted);

    const posted = await c.offers.create(ad);
    expect(posted).toMatchObject({ status: 'active', makerId: MAKER, totalAmount: '100', remainingAmount: '100' });
    // The same submit again (a double tap, or a retry after a lost reply) answers the same ad.
    expect((await c.offers.create(ad)).id).toBe(posted.id);
    expect(await offers()).toHaveLength(1);
    // Nothing is reserved at post: the ledger saw only the TEST funding.
    expect(ledger.journal()).toHaveLength(1);
    expect((await ledger.balance(userAvailable(MAKER, ASSET))).amount).toBe(parseAmount('100'));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('accepting is the person’s own act, and one person’s acceptance covers no one else', async () => {
    const p2p = service();
    // An API key cannot accept for the person.
    await expect(caller(p2p, { kid: 'key-1' }).merchants.acceptAdvertiserTerms({ version: VERSION })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller(p2p).merchants.advertiserTerms()).resolves.toEqual({ version: VERSION, acceptedAt: null });
    await caller(p2p).merchants.acceptAdvertiserTerms({ version: VERSION });
    // The service gate holds for every post, whatever door it came through: no version sent is still checked.
    await expect(p2p.createOffer(serviceAd())).resolves.toMatchObject({ status: 'active' });
    // Acceptance is per person: another account has not accepted.
    await expect(caller(p2p, { userId: OTHER }).merchants.advertiserTerms()).resolves.toEqual({ version: VERSION, acceptedAt: null });
    await expect(p2p.createOffer({ ...serviceAd(), makerId: OTHER, side: 'buy' })).rejects.toMatchObject({
      code: 'p2p.terms_not_accepted',
    });
  });

  it('a form that showed another version is refused as stale, and accepting a version that is not published is refused', async () => {
    const c = caller(service());
    await expect(c.merchants.acceptAdvertiserTerms({ version: 'TEST-v0' })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'p2p.terms_version_stale' }),
    });
    await c.merchants.acceptAdvertiserTerms({ version: VERSION });
    await expect(c.offers.create(sellAd({ advertiserTermsVersion: 'TEST-v0' }))).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: expect.objectContaining({ code: 'p2p.terms_version_stale' }),
    });
    expect(await offers()).toHaveLength(0);
    // A new published version asks everyone to accept again.
    const next = caller(service('TEST-v2'));
    expect(await next.merchants.advertiserTerms()).toEqual({ version: 'TEST-v2', acceptedAt: null });
    await expect(next.offers.create(sellAd())).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'p2p.terms_not_accepted' }),
    });
  });

  it('with no published version every post refuses p2p.config_unset naming the setting', async () => {
    expect(advertiserTermsVersion('  ')).toBeNull();
    const c = caller(service(null));
    for (const call of [() => c.merchants.advertiserTerms(), () => c.merchants.acceptAdvertiserTerms({ version: VERSION })])
      await expect(call()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        cause: expect.objectContaining({ code: 'p2p.config_unset', message: expect.stringContaining('P2P_ADVERTISER_TERMS_VERSION') }),
      });
    await expect(c.offers.create(sellAd())).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'p2p.config_unset' }) });
    // A service built without the terms (tests elsewhere) refuses the doors the same way rather than claiming none.
    const bare = caller(new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), { instruments, feeBps: 0 }));
    await expect(bare.merchants.advertiserTerms()).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'p2p.config_unset' }) });
    expect(await offers()).toHaveLength(0);
  });

  it('a sell total above the free balance refuses with the free amount and the shortfall; equal posts; a buy ad is not checked', async () => {
    const p2p = service();
    const c = caller(p2p);
    await c.merchants.acceptAdvertiserTerms({ version: VERSION });
    expect(await c.offers.sellBalance({ asset: ASSET })).toEqual({ asset: ASSET, available: '100' });
    const refused = await c.offers.create(sellAd({ totalAmount: '100.5' })).catch((err: { code: string; cause: P2pError }) => err);
    expect(refused).toMatchObject({ code: 'CONFLICT', cause: expect.objectContaining({ code: 'p2p.insufficient_balance' }) });
    expect((refused as { cause: P2pError }).cause.limit).toEqual({ until: null, available: '100', shortBy: '0.5' });
    expect(await offers()).toHaveLength(0);

    await expect(c.offers.create(sellAd({ totalAmount: '100' }))).resolves.toMatchObject({ status: 'active' });
    // A second sell ad may promise the same free balance: nothing is reserved at post, the escrow locks per order.
    await expect(c.offers.create(sellAd({ totalAmount: '100' }))).resolves.toMatchObject({ status: 'active' });
    // A buy ad's maker pays fiat; their coin balance is not what it offers.
    await expect(c.offers.create(sellAd({ side: 'buy', totalAmount: '5000', maxAmount: '50' }))).resolves.toMatchObject({ side: 'buy' });
    // Another account's balance is never read: its free balance is its own.
    expect(await caller(p2p, { userId: OTHER }).offers.sellBalance({ asset: ASSET })).toEqual({ asset: ASSET, available: '0' });
    expect(ledger.journal()).toHaveLength(1);
  });

  it('a retry with the same key answers the posted ad even after the balance fell and the terms moved on', async () => {
    const c = caller(service());
    await c.merchants.acceptAdvertiserTerms({ version: VERSION });
    const ad = sellAd({ advertiserTermsVersion: VERSION });
    const posted = await c.offers.create(ad);
    // The maker's coins leave (a withdrawal elsewhere): a new post of that size is now refused.
    await ledger.post(
      recipes.escrowLock({ tradeId: crypto.randomUUID(), sellerId: MAKER, buyerId: OTHER, assetId: ASSET, amount: parseAmount('60') }),
    );
    await expect(c.offers.create(sellAd())).rejects.toMatchObject({ cause: expect.objectContaining({ code: 'p2p.insufficient_balance' }) });
    // The lost reply's retry still answers the ad it posted, under a newer terms version too.
    expect((await c.offers.create(ad)).id).toBe(posted.id);
    expect((await caller(service('TEST-v2')).offers.create(ad)).id).toBe(posted.id);
    expect(await offers()).toHaveLength(1);
  });

  it('a merchant client retrying by offer id alone, with no key, also gets its posted ad back', async () => {
    const p2p = service();
    await caller(p2p).merchants.acceptAdvertiserTerms({ version: VERSION });
    const offerId = adId();
    const posted = await p2p.createOffer({ ...serviceAd(), offerId, totalAmt: parseAmount('100') });
    await ledger.post(
      recipes.escrowLock({ tradeId: crypto.randomUUID(), sellerId: MAKER, buyerId: OTHER, assetId: ASSET, amount: parseAmount('60') }),
    );
    const terms = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      advertiserTerms: createAdvertiserTerms({ acceptances: new AdvertiserTermsAcceptances(sql), version: 'TEST-v2' }),
      sellBalanceAtPost: true,
    });
    expect((await terms.createOffer({ ...serviceAd(), offerId, totalAmt: parseAmount('100') })).id).toBe(posted.id);
    // Another maker naming that id is not a retry: it is checked, and refused.
    await expect(terms.createOffer({ ...serviceAd(), makerId: OTHER, side: 'buy', offerId })).rejects.toMatchObject({
      code: 'p2p.terms_not_accepted',
    });
  });

  it('a free balance is read signed in only, never with an API key', async () => {
    // A key outside the merchant programme is turned away at the door; a programme member's key by this door's own check.
    await expect(caller(service(), { kid: 'key-1' }).offers.sellBalance({ asset: ASSET })).rejects.toMatchObject({
      code: expect.stringMatching(/^(FORBIDDEN|PRECONDITION_FAILED)$/),
    });
  });

  function serviceAd() {
    return {
      makerId: MAKER,
      side: 'sell' as const,
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed' as const,
      price: parseAmount('1'),
      minAmt: parseAmount('1'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('50'),
      methods: ['sepa'],
      terms: 'TEST terms',
    };
  }
});
