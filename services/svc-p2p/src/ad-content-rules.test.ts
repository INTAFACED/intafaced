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
import { parseAdContentRules, type AdContentRules } from './ad-content-rules.js';

/**
 * P-ads-merchant-05 / J-p2p-03 #5: an ad's terms are screened against compliance's content rules at post and at edit,
 * refused with the rule class and nothing saved; an unpublished list screens nothing, a broken one refuses every post.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const MAKER = '44444444-4444-4444-8444-444444444444';
const ASSET = 'USDT';
const RULES = parseAdContentRules(JSON.stringify({ messenger: ['telegram', 'whatsapp'], link: ['https://'] }));

describe('svc-p2p ad content rules at post and edit (P-ads-merchant-05)', () => {
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

  const service = (adContentRules: AdContentRules = RULES) =>
    new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), { instruments, feeBps: 0, adContentRules, sellBalanceAtPost: true });

  let n = 0;
  const ad = (terms: string, key = `content-${++n}`) => ({
    makerId: MAKER,
    side: 'sell' as const,
    asset: ASSET,
    fiatCurrency: 'EUR',
    priceType: 'fixed' as const,
    price: parseAmount('0.93'),
    minAmt: parseAmount('10'),
    maxAmt: parseAmount('50'),
    totalAmt: parseAmount('100'),
    methods: ['sepa'],
    terms,
    idempotencyKey: key,
  });
  const offers = async () => sql<{ id: string }[]>`SELECT id FROM p2p.offers`;

  it('refuses terms that break a rule with the rule class and never the phrase, and posts nothing', async () => {
    const refused = service().createOffer(ad('TEST terms: message me on Telegram before you pay'));
    await expect(refused).rejects.toMatchObject({ code: 'p2p.content_rule_violation' });
    await expect(refused).rejects.toThrow('"messenger"');
    await expect(refused).rejects.not.toThrow(/telegram/i);
    expect(await offers()).toHaveLength(0);
    await expect(service().createOffer(ad('TEST terms: pay from an account in your own name.'))).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('screens nothing when no list is published, and refuses every post on a list that is not whole', async () => {
    await expect(service({ status: 'absent' }).createOffer(ad('telegram me'))).resolves.toBeTruthy();
    await expect(service(parseAdContentRules('{"messenger":[]}')).createOffer(ad('clean terms'))).rejects.toMatchObject({
      code: 'p2p.content_rules_invalid',
    });
  });

  it('screens edited terms, keeps the ad as it was on a refusal, and leaves terms an edit does not touch alone', async () => {
    const posted = await service({ status: 'absent' }).createOffer(ad('see https://example.test'));
    const p2p = service();
    await expect(
      p2p.updateOffer({ offerId: posted.id, makerId: MAKER, idempotencyKey: 'edit-terms', terms: 'whatsapp only' }),
    ).rejects.toMatchObject({ code: 'p2p.content_rule_violation' });
    const [row] = await sql<{ terms: string }[]>`SELECT terms FROM p2p.offers WHERE id = ${posted.id}`;
    expect(row!.terms).toBe('see https://example.test');
    // An edit of the price alone does not re-judge terms posted before the list.
    await expect(
      p2p.updateOffer({ offerId: posted.id, makerId: MAKER, idempotencyKey: 'edit-price', price: parseAmount('0.94') }),
    ).resolves.toMatchObject({ price: parseAmount('0.94') });
    await expect(
      p2p.updateOffer({ offerId: posted.id, makerId: MAKER, idempotencyKey: 'edit-clean', terms: 'own-name accounts only' }),
    ).resolves.toMatchObject({ terms: 'own-name accounts only' });
  });

  it('answers a retry of an ad posted before the list was published', async () => {
    const posted = await service({ status: 'absent' }).createOffer(ad('telegram me', 'before-rules'));
    await expect(service().createOffer(ad('telegram me', 'before-rules'))).resolves.toMatchObject({ id: posted.id });
  });
});
