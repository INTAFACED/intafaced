import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';
import { parseVerificationLimits, type VerificationLimitConfig } from './verification-limits.js';

/**
 * P-ads-merchant-02 / J-p2p-03 #4: a buy ad's per-order range fits its maker's verification level, refused at post and
 * at edit with the level's band; an edit that makes a sell ad offer more than the free balance is refused as a new ad.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '33333333-3333-4333-8333-333333333333';
const ASSET = 'USDT';
const caps = (orderMax: string) => ({ orderMin: '0.5', orderMax, dailyMax: '600', lifetimeMax: '100000' });
const TABLE = parseVerificationLimits(
  JSON.stringify({ currency: 'EUR', tiers: { none: caps('100'), basic: caps('500'), full: caps('600'), institutional: caps('600') } }),
);

describe('svc-p2p per-order limits by level and the balance on edit (P-ads-merchant-02)', () => {
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

  const service = (verificationLimits: VerificationLimitConfig = TABLE) =>
    new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      verificationLimits,
      sellBalanceAtPost: true,
      // A TEST reference, so the floating buy ad below posts (P-ads-merchant-03) and is left to the take.
      referencePrices: { price: async () => parseAmount('0.93') },
    });

  let n = 0;
  const ad = (extra: Partial<Parameters<P2pService['createOffer']>[0]> = {}) => ({
    makerId: MAKER,
    side: 'buy' as const,
    asset: ASSET,
    fiatCurrency: 'EUR',
    priceType: 'fixed' as const,
    price: parseAmount('0.93'),
    minAmt: parseAmount('10'),
    maxAmt: parseAmount('500'),
    totalAmt: parseAmount('1000'),
    methods: ['sepa'],
    makerTier: 'basic',
    idempotencyKey: `level-${++n}`,
    ...extra,
  });
  const offers = async () => sql<{ id: string }[]>`SELECT id FROM p2p.offers`;

  it('posts a buy ad whose orders fit the level: 500 x 0.93 = 465 EUR under 500', async () => {
    await expect(service().createOffer(ad())).resolves.toMatchObject({ side: 'buy', status: 'active' });
  });

  it('refuses a buy ad whose per-order maximum passes the level, with the band, and posts nothing', async () => {
    // 538 x 0.93 = 500.34 EUR, above the basic level's 500.
    await expect(service().createOffer(ad({ maxAmt: parseAmount('538') }))).rejects.toMatchObject({
      code: 'p2p.verification_order_max',
      limit: { until: null, min: '0.5', max: '500', currency: 'EUR' },
    });
    // The lower level's 100 EUR refuses the 465 EUR ad the basic level takes.
    await expect(service().createOffer(ad({ makerTier: 'none' }))).rejects.toMatchObject({ code: 'p2p.verification_order_max' });
    expect(await offers()).toHaveLength(0);
  });

  it('prices the smallest and largest order as a take does, to the cent, so it refuses exactly what a take would', async () => {
    // 0.53 x 0.93 = 0.4929, a take of 0.49 EUR: under 0.5.
    await expect(service().createOffer(ad({ minAmt: parseAmount('0.53') }))).rejects.toMatchObject({
      code: 'p2p.verification_order_min',
      limit: { min: '0.5', max: '500', currency: 'EUR' },
    });
    // 537.635 x 0.93 = 500.00055, a take of 500.00 EUR: inside, so the ad posts.
    await expect(service().createOffer(ad({ maxAmt: parseAmount('537.635') }))).resolves.toBeTruthy();
    // 537.64 x 0.93 = 500.0052, a take of 500.01 EUR: past it.
    await expect(service().createOffer(ad({ maxAmt: parseAmount('537.64') }))).rejects.toMatchObject({
      code: 'p2p.verification_order_max',
    });
  });

  it('answers a retry of a buy ad posted before the table, rather than refusing it', async () => {
    const posted = await service({ status: 'absent' }).createOffer(ad({ maxAmt: parseAmount('900'), idempotencyKey: 'before-table' }));
    await expect(service().createOffer(ad({ maxAmt: parseAmount('900'), idempotencyKey: 'before-table' }))).resolves.toMatchObject({
      id: posted.id,
    });
  });

  it('lets a buy ad listed past the level be brought down step by step, and refuses only an edit that widens it', async () => {
    const legacy = await service({ status: 'absent' }).createOffer(ad({ maxAmt: parseAmount('1000'), makerTier: undefined }));
    const p2p = service();
    // 600 x 0.93 = 558 EUR, still past 500, but narrower than 930: allowed, even with no level stored on the row.
    await expect(
      p2p.updateOffer({ offerId: legacy.id, makerId: MAKER, idempotencyKey: 'down-1', maxAmt: parseAmount('600') }),
    ).resolves.toMatchObject({ maxAmt: parseAmount('600') });
    // Widening it again is checked, and the row has no level to check it on.
    await expect(
      p2p.updateOffer({ offerId: legacy.id, makerId: MAKER, idempotencyKey: 'up-1', maxAmt: parseAmount('700') }),
    ).rejects.toMatchObject({ code: 'p2p.verification_level_unwired' });
  });

  it('names a buy ad in another currency, an unwired level and a broken table, as a take would', async () => {
    await expect(service().createOffer(ad({ fiatCurrency: 'USD' }))).rejects.toMatchObject({ code: 'p2p.verification_limit_currency' });
    await expect(service().createOffer(ad({ makerTier: undefined }))).rejects.toMatchObject({ code: 'p2p.verification_level_unwired' });
    await expect(service({ status: 'invalid' }).createOffer(ad())).rejects.toMatchObject({ code: 'p2p.verification_limits_invalid' });
    expect(await offers()).toHaveLength(0);
  });

  it('leaves sell ads, floating buy ads and an unpublished table to the take', async () => {
    const p2p = service();
    await expect(
      p2p.createOffer(ad({ side: 'sell', maxAmt: parseAmount('100'), totalAmt: parseAmount('100'), makerTier: 'none' })),
    ).resolves.toBeTruthy();
    await expect(p2p.createOffer(ad({ priceType: 'float', price: parseAmount('1.02'), maxAmt: parseAmount('900') }))).resolves.toBeTruthy();
    await expect(service({ status: 'absent' }).createOffer(ad({ maxAmt: parseAmount('900') }))).resolves.toBeTruthy();
  });

  it('refuses an edit that takes a buy ad past the level it was posted at, and keeps the ad as it was', async () => {
    const p2p = service();
    const posted = await p2p.createOffer(ad());
    await expect(
      p2p.updateOffer({ offerId: posted.id, makerId: MAKER, idempotencyKey: 'edit-price', price: parseAmount('1.10') }),
    ).rejects.toMatchObject({ code: 'p2p.verification_order_max', limit: { max: '500', currency: 'EUR' } });
    const [row] = await sql<{ price: string }[]>`SELECT price::text FROM p2p.offers WHERE id = ${posted.id}`;
    expect(parseAmount(row!.price)).toBe(parseAmount('0.93'));
    await expect(
      p2p.updateOffer({ offerId: posted.id, makerId: MAKER, idempotencyKey: 'edit-max', maxAmt: parseAmount('400') }),
    ).resolves.toMatchObject({ maxAmt: parseAmount('400') });
  });

  it('refuses an edit that makes a sell ad offer more than the free balance, and allows one that offers less', async () => {
    const p2p = service();
    const posted = await p2p.createOffer(ad({ side: 'sell', maxAmt: parseAmount('50'), totalAmt: parseAmount('80') }));
    await expect(
      p2p.updateOffer({ offerId: posted.id, makerId: MAKER, idempotencyKey: 'edit-total-up', totalAmt: parseAmount('120') }),
    ).rejects.toMatchObject({ code: 'p2p.insufficient_balance', limit: { until: null, available: '100', shortBy: '20' } });
    await expect(
      p2p.updateOffer({ offerId: posted.id, makerId: MAKER, idempotencyKey: 'edit-total-100', totalAmt: parseAmount('100') }),
    ).resolves.toMatchObject({ totalAmt: parseAmount('100') });
    // Offering less never reads the balance: a spent balance does not stop an ad shrinking.
    await ledger.post(
      recipes.withdrawHold({ userId: MAKER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', withdrawalId: 'out-1' }),
    );
    await expect(
      p2p.updateOffer({ offerId: posted.id, makerId: MAKER, idempotencyKey: 'edit-total-down', totalAmt: parseAmount('60') }),
    ).resolves.toMatchObject({ totalAmt: parseAmount('60') });
  });
});
