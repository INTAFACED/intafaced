/**
 * J-bank-29 #1 and #2 (BK-ccrypto-01): Pay from over real rows. The partner's balance and the rate for each asset the
 * partner can spend from, "not known" where a source is silent (never 0), and the saved pay-from order with its refusals.
 * Nothing here moves value: the partner holds the money (OWNER 226), and the ledger journal shows no
 * posting happens: the journal holds only the funding deposit before and after.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CardService } from './card-service.js';
import { cardSim } from './issuer.js';
import { cardSimPartnerFor, type CardPartnerTerms } from './partner-terms.js';
import type { PriceSource, QuotedMark } from '../loans/prices.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const PARTNER: CardPartnerTerms = cardSimPartnerFor(
  JSON.stringify({
    custodyMode: 'partner_holds',
    spendFrom: ['USDC', 'BTC', 'USD'],
    lossLiability: null,
    reserve: null,
    funder: null,
    balances: { USDC: '30', BTC: '0.01', USD: '50' },
    programmeFigures: null,
    fundingAssetId: null,
    fundingOffers: null,
  }),
  { APP_ENV: 'test' },
);
const AT = new Date('2026-11-08T12:00:00.000Z');
/** A TEST rate source: BTC in USDC, USDC in itself, and nothing for USD (no market), as the stack's ticker. */
const rates: PriceSource = {
  marks: async (assets, quote) => {
    const out = new Map<string, QuotedMark>();
    for (const a of assets) {
      if (a === quote) out.set(a, { assetId: a, price: amt('1'), asOf: AT, quality: 'index' });
      else if (a === 'BTC' && quote === 'USDC') out.set(a, { assetId: a, price: amt('65000.5'), asOf: AT, quality: 'mid' });
    }
    return out;
  },
};

describe('Pay from (J-bank-29 #1 #2, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let user: string;
  const service = (partner: CardPartnerTerms = PARTNER, spendAssets: readonly string[] | null = ['USDC', 'BTC', 'USD'], source = rates) =>
    new CardService(sql, ledger, { issuer: cardSim({ partner }), spendAssets, rates: source });

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 60_000);

  beforeEach(async () => {
    ledger = new MemoryLedger();
    user = randomUUID();
    await ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: `fund:${user}` }));
    await service().issue({
      cardId: randomUUID(),
      userId: user,
      assetId: 'USDT',
      settlementAssetId: 'USDC',
      perAuthorizationLimit: amt('50'),
    });
  });

  const entries = async () => ledger.journal().length;

  it('each offered asset carries the partner balance and the rate in the settlement asset with its time; a silent source is "not known", never 0', async () => {
    const before = await entries();
    const view = await service().payFrom(user);
    expect(view.settlementAssetId).toBe('USDC');
    expect(view.assets).toEqual([
      { assetId: 'USDC', state: 'offered', partnerBalance: '30', rate: '1', rateAsOf: AT.toISOString() },
      { assetId: 'BTC', state: 'offered', partnerBalance: '0.01', rate: '65000.5', rateAsOf: AT.toISOString() },
      // No USD market on the rate source: the rate is null ("not known"), not 0 and not 1.
      { assetId: 'USD', state: 'offered', partnerBalance: '50', rate: null, rateAsOf: null },
      // The person's USDT card: the partner cannot spend from it, so no balance or rate is shown for it.
      { assetId: 'USDT', state: 'not_offered', partnerBalance: null, rate: null, rateAsOf: null },
    ]);
    expect(view.order).toBeNull();
    expect(view.notUsedForCards).toEqual(['trading', 'agent']);
    expect(await entries()).toEqual(before);
  });

  it('a partner that reports no balances reads each "not known"; a rate source that throws reads each rate "not known"', async () => {
    const silent = service({ ...PARTNER, balances: null }, undefined, {
      marks: async () => {
        throw new Error('ticker down');
      },
    });
    const view = await silent.payFrom(user);
    for (const row of view.assets) expect(row).toMatchObject({ partnerBalance: null, rate: null, rateAsOf: null });
  });

  it('an asset the partner map leaves out reads "not known", not 0', async () => {
    const view = await service({ ...PARTNER, balances: { USDC: '30' } }).payFrom(user);
    expect(view.assets.find((a) => a.assetId === 'BTC')?.partnerBalance).toBeNull();
  });

  it('cards that settle in different assets quote no rate rather than guess which card pays', async () => {
    await service().issue({ cardId: randomUUID(), userId: user, assetId: 'USDT', perAuthorizationLimit: amt('50') });
    const view = await service().payFrom(user);
    expect(view.settlementAssetId).toBeNull();
    for (const row of view.assets) expect(row.rate).toBeNull();
  });

  it('saves the order USDC, BTC, USD and reads it back; saving it again changes nothing', async () => {
    const saved = await service().setPayFromOrder(user, ['USDC', 'BTC', 'USD']);
    expect(saved.order).toEqual(['USDC', 'BTC', 'USD']);
    const [first] = await sql<Array<{ updated_at: Date }>>`SELECT updated_at FROM bank.card_pay_from_orders WHERE user_id = ${user}`;
    await service().setPayFromOrder(user, ['USDC', 'BTC', 'USD']);
    const [again] = await sql<Array<{ updated_at: Date }>>`SELECT updated_at FROM bank.card_pay_from_orders WHERE user_id = ${user}`;
    expect(again!.updated_at.getTime()).toBe(first!.updated_at.getTime());
    expect((await service().setPayFromOrder(user, ['BTC', 'USDC'])).order).toEqual(['BTC', 'USDC']);
    expect((await service().payFrom(user)).order).toEqual(['BTC', 'USDC']);
  });

  it('refuses an order naming an asset the partner cannot spend from, twice, or none, and saves nothing', async () => {
    await expect(service().setPayFromOrder(user, ['USDC', 'USDT'])).rejects.toMatchObject({ code: 'bank.card_pay_from_not_offered' });
    await expect(service({ ...PARTNER, spendFrom: ['USDC', 'USD'] }).setPayFromOrder(user, ['BTC'])).rejects.toMatchObject({
      code: 'bank.card_pay_from_not_offered',
    });
    await expect(service({ ...PARTNER, spendFrom: null }).setPayFromOrder(user, ['USDC'])).rejects.toMatchObject({
      code: 'bank.card_pay_from_not_offered',
    });
    await expect(service().setPayFromOrder(user, ['USDC', 'USDC'])).rejects.toMatchObject({ code: 'bank.card_pay_from_order_invalid' });
    await expect(service().setPayFromOrder(user, [])).rejects.toMatchObject({ code: 'bank.card_pay_from_order_invalid' });
    expect(await sql`SELECT 1 FROM bank.card_pay_from_orders WHERE user_id = ${user}`).toHaveLength(0);
  });

  it('with the owner list unset no order can be saved (J-bank-29 #1): bank.card_spend_assets_unset', async () => {
    await expect(service(PARTNER, null).setPayFromOrder(user, ['USDC'])).rejects.toMatchObject({ code: 'bank.card_spend_assets_unset' });
    expect(await sql`SELECT 1 FROM bank.card_pay_from_orders WHERE user_id = ${user}`).toHaveLength(0);
  });
});
