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
import { parsePostingThresholds, type PostingThresholds } from './posting-eligibility.js';

/**
 * P-ads-merchant-12 / J-p2p-03 #1: the posting checklist for a fiat shows every published threshold with the person's
 * value and the target, and posting in that fiat refuses on the same checks; a fiat with nothing published refuses
 * `p2p.config_unset`, "none" leaves posting to the jurisdiction gate, a broken list refuses every post.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '55555555-5555-4555-8555-555555555555';
const ASSET = 'USDT';
const THRESHOLDS = parsePostingThresholds(JSON.stringify({ EUR: { minKycTier: 'basic', minCompletedOrders: '0' }, USD: 'none' }));

describe('svc-p2p posting thresholds at post, and the posting checklist (P-ads-merchant-12)', () => {
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
    for (const fiatCurrency of ['EUR', 'USD', 'GBP'])
      await instruments.createInstrument({
        ownerId: MAKER,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency,
        label: `sepa ${fiatCurrency}`,
        details: { account_reference: `ref-maker-${fiatCurrency}` },
        instrumentId: crypto.randomUUID(),
      });
    await ledger.post(
      recipes.deposit({ userId: MAKER, assetId: ASSET, amount: parseAmount('100'), rail: 'test', railRef: `${MAKER}:fund` }),
    );
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const service = (postingThresholds: PostingThresholds | null = THRESHOLDS) =>
    new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 0,
      ...(postingThresholds === null ? {} : { postingThresholds }),
    });

  let n = 0;
  const ad = (fiatCurrency = 'EUR', makerTier: string | undefined = 'basic', key = `posting-${++n}`) => ({
    makerId: MAKER,
    side: 'sell' as const,
    asset: ASSET,
    fiatCurrency,
    priceType: 'fixed' as const,
    price: parseAmount('0.93'),
    minAmt: parseAmount('10'),
    maxAmt: parseAmount('50'),
    totalAmt: parseAmount('100'),
    methods: ['sepa'],
    idempotencyKey: key,
    ...(makerTier === undefined ? {} : { makerTier }),
  });
  const offers = async () => sql<{ id: string }[]>`SELECT id FROM p2p.offers`;

  it('lists every threshold with both values, and posts when each is met', async () => {
    const p2p = service();
    await expect(p2p.postingEligibility({ userId: MAKER, tier: 'basic', fiatCurrency: 'EUR' })).resolves.toEqual({
      policy: 'thresholds',
      checks: [
        { id: 'kyc_tier', state: 'met', current: 'basic', required: 'basic', reason: 'posting.met' },
        { id: 'completed_orders', state: 'met', current: '0', required: '0', reason: 'posting.met' },
      ],
    });
    await expect(p2p.createOffer(ad('EUR', 'full'))).resolves.toMatchObject({ status: 'active' });
  });

  it('refuses a post below a threshold, says which one on the checklist, and posts nothing', async () => {
    const p2p = service(parsePostingThresholds(JSON.stringify({ EUR: { minKycTier: 'full' } })));
    await expect(p2p.createOffer(ad('EUR', 'basic'))).rejects.toMatchObject({ code: 'p2p.posting_threshold_not_met' });
    await expect(p2p.createOffer(ad('EUR', undefined))).rejects.toMatchObject({ code: 'p2p.posting_threshold_not_met' });
    expect(await offers()).toHaveLength(0);
    const { checks } = await p2p.postingEligibility({ userId: MAKER, tier: 'basic', fiatCurrency: 'EUR' });
    expect(checks).toEqual([
      { id: 'kyc_tier', state: 'not_met', current: 'basic', required: 'full', reason: 'p2p.posting_threshold_not_met' },
    ]);
    const unwired = await p2p.postingEligibility({ userId: MAKER, tier: undefined, fiatCurrency: 'EUR' });
    expect(unwired.checks[0]).toMatchObject({ state: 'unknown', current: null, reason: 'p2p.verification_level_unwired' });
  });

  it('counts finished orders, and a rate with no finished order is unknown, which refuses', async () => {
    const p2p = service(parsePostingThresholds(JSON.stringify({ EUR: { minCompletedOrders: '1', minCompletionRatePct: '90' } })));
    const { checks } = await p2p.postingEligibility({ userId: MAKER, tier: 'basic', fiatCurrency: 'EUR' });
    expect(checks).toEqual([
      { id: 'completed_orders', state: 'not_met', current: '0', required: '1', reason: 'p2p.posting_threshold_not_met' },
      { id: 'completion_rate', state: 'unknown', current: null, required: '90', reason: 'p2p.completion_rate_none' },
    ]);
    await expect(p2p.createOffer(ad())).rejects.toMatchObject({ code: 'p2p.posting_threshold_not_met' });
    expect(await offers()).toHaveLength(0);
  });

  it('refuses a fiat with nothing published naming it, posts under "none", and refuses every post on a broken list', async () => {
    const unset = service().createOffer(ad('GBP'));
    await expect(unset).rejects.toMatchObject({ code: 'p2p.config_unset' });
    await expect(unset).rejects.toThrow('GBP');
    await expect(service({ status: 'absent' }).createOffer(ad('EUR'))).rejects.toMatchObject({ code: 'p2p.config_unset' });
    await expect(service().createOffer(ad('USD', undefined))).resolves.toMatchObject({ status: 'active' });
    await expect(service(parsePostingThresholds('{"EUR":{}}')).createOffer(ad('USD'))).rejects.toMatchObject({
      code: 'p2p.posting_thresholds_invalid',
    });
    expect(await service().postingEligibility({ userId: MAKER, tier: 'basic', fiatCurrency: 'USD' })).toEqual({
      policy: 'none',
      checks: [],
    });
    expect((await service().postingEligibility({ userId: MAKER, tier: 'basic', fiatCurrency: 'GBP' })).policy).toBe('unset');
    expect(
      (await service(parsePostingThresholds('[]')).postingEligibility({ userId: MAKER, tier: 'basic', fiatCurrency: 'EUR' })).policy,
    ).toBe('invalid');
  });

  it('reads the fiat in capitals, as a post stores it, so the checklist and the post agree', async () => {
    const p2p = service(parsePostingThresholds(JSON.stringify({ EUR: { minKycTier: 'full' } })));
    expect((await p2p.postingEligibility({ userId: MAKER, tier: 'basic', fiatCurrency: 'eur' })).checks[0]).toMatchObject({
      id: 'kyc_tier',
      state: 'not_met',
    });
    await expect(p2p.createOffer(ad('eur', 'basic'))).rejects.toMatchObject({ code: 'p2p.posting_threshold_not_met' });
  });

  it('answers a retry of an ad posted before the thresholds were published', async () => {
    const posted = await service(null).createOffer(ad('GBP', undefined, 'before-thresholds'));
    await expect(service().createOffer(ad('GBP', undefined, 'before-thresholds'))).resolves.toMatchObject({ id: posted.id });
  });
});
