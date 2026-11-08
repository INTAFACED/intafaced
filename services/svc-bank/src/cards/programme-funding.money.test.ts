/**
 * J-bank-26 #6 (BK-cops-05): programme funding over real rows. The settlement reconciliation of the app's open holds and
 * captures against the partner's own figures (matches, a break, or "not known" when the partner is silent, never 0), the
 * stablecoin conversion into the funding asset, and a funding instruction sent only where the partner offers it, with its
 * approval consumed only after that check, replayed by its key, and nothing posted to the ledger for it.
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
import { fundingOfferStates } from './programme-funding.js';
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

const REPORTED: CardPartnerTerms = cardSimPartnerFor(
  JSON.stringify({
    custodyMode: 'partner_holds',
    spendFrom: ['USDC', 'BTC', 'USD'],
    lossLiability: null,
    reserve: { required: true, amount: '25000', assetId: 'USDC' },
    funder: 'TEST: the programme pre-funds in USDC',
    balances: null,
    programmeFigures: { USDT: { held: '5', captured: '20' }, BTC: { held: '0', captured: '0.0005' } },
    fundingAssetId: 'USDC',
    fundingOffers: { fund: true, defund: true, autoReload: false },
  }),
  { APP_ENV: 'test' },
);
const AT = new Date('2026-11-08T12:00:00.000Z');
/** USDT in USDC at 0.9998 and BTC at 65000, as a TEST ticker; nothing else. */
const rates: PriceSource = {
  marks: async (assets, quote) => {
    const out = new Map<string, QuotedMark>();
    for (const a of assets) {
      if (quote !== 'USDC') continue;
      if (a === 'USDT') out.set(a, { assetId: a, price: amt('0.9998'), asOf: AT, quality: 'mid' });
      if (a === 'BTC') out.set(a, { assetId: a, price: amt('65000'), asOf: AT, quality: 'mid' });
    }
    return out;
  },
};

describe('programme funding (J-bank-26 #6, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  const service = (partner: CardPartnerTerms = REPORTED) => new CardService(sql, ledger, { issuer: cardSim({ partner }), rates });

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
    await sql`TRUNCATE bank.card_programme_funding_requests`;
    await sql`TRUNCATE bank.card_settlements, bank.card_conversions, bank.card_cashback, bank.card_authorizations CASCADE`;
  });

  it('reconciles open holds and captures against the partner: matches, a break, and "not known" where the partner is silent', async () => {
    const user = randomUUID();
    await ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: `fund:${user}` }));
    const card = await service().issue({ cardId: randomUUID(), userId: user, assetId: 'USDT', perAuthorizationLimit: amt('50') });
    await service().authorize({ cardId: card.id, authorizationRef: 'r-open', amount: amt('5') });
    await service().authorize({ cardId: card.id, authorizationRef: 'r-cap', amount: amt('25') });
    await service().capture({ cardId: card.id, authorizationRef: 'r-cap', amount: amt('20') });

    const view = await service().programmeFunding();
    const usdt = view.rows.find((r) => r.assetId === 'USDT');
    // 5 open, 20 captured (the 5 remainder returned): 25, equal to the partner's 5 + 20.
    expect(usdt).toMatchObject({
      appHeld: '5',
      appCaptured: '20',
      appFigure: '25',
      partnerFigure: '25',
      difference: '0',
      status: 'matches',
    });
    // The stablecoin conversion: 25 USDT at 0.9998 USDC, rounded up.
    expect(usdt).toMatchObject({ fundingRate: '0.9998', fundingRateAsOf: AT.toISOString(), appFigureInFunding: '24.995' });
    // A partner capture the app has no record of is a break, signed partner minus app.
    expect(view.rows.find((r) => r.assetId === 'BTC')).toMatchObject({
      appFigure: '0',
      partnerFigure: '0.0005',
      difference: '0.0005',
      status: 'break',
    });

    const silent = await service({ ...REPORTED, programmeFigures: null, fundingAssetId: null }).programmeFunding();
    expect(silent.rows).toEqual([
      expect.objectContaining({
        assetId: 'USDT',
        appFigure: '25',
        partnerFigure: null,
        difference: null,
        status: 'not_known',
        fundingRate: null,
      }),
    ]);
  });

  it('reads fund, defund and auto reload as the partner offers them, and "not known" when it is silent', () => {
    expect(fundingOfferStates(REPORTED)).toEqual({ fund: 'offered', defund: 'offered', auto_reload: 'not_offered' });
    expect(fundingOfferStates({ ...REPORTED, fundingOffers: null })).toEqual({
      fund: 'not_known',
      defund: 'not_known',
      auto_reload: 'not_known',
    });
  });

  it('sends an offered instruction once, with its approval used once and nothing posted; the same key replays it', async () => {
    let consumed = 0;
    const consume = async () => void consumed++;
    const before = ledger.journal().length;
    const first = await service().requestProgrammeFunding({
      kind: 'fund',
      amount: '1000',
      threshold: null,
      reason: 'TEST top up for the month',
      clientRequestId: 'op-1',
      consume,
    });
    expect(first).toMatchObject({ kind: 'fund', assetId: 'USDC', amount: '1000', threshold: null });
    expect(first.partnerRef).toMatch(/^TEST-card-sim-[0-9a-f]{16}$/);
    const again = await service().requestProgrammeFunding({
      kind: 'fund',
      amount: '1000',
      threshold: null,
      reason: 'TEST top up for the month',
      clientRequestId: 'op-1',
      consume,
    });
    expect(again).toEqual(first);
    expect(consumed).toBe(1);
    expect(ledger.journal().length).toBe(before);
    expect((await service().programmeFunding()).requests).toEqual([first]);
  });

  it('refuses before using the approval: a kind the partner does not offer, a silent partner, a bad amount or threshold', async () => {
    let consumed = 0;
    const consume = async () => void consumed++;
    const ask = (over: Partial<Parameters<CardService['requestProgrammeFunding']>[0]>, partner = REPORTED) =>
      service(partner).requestProgrammeFunding({
        kind: 'fund',
        amount: '10',
        threshold: null,
        reason: 'TEST reason long enough',
        clientRequestId: randomUUID(),
        consume,
        ...over,
      });
    await expect(ask({ kind: 'auto_reload', threshold: '100' })).rejects.toMatchObject({ code: 'bank.card_funding_not_offered' });
    await expect(ask({}, { ...REPORTED, fundingOffers: null })).rejects.toMatchObject({ code: 'bank.card_funding_not_offered' });
    await expect(ask({}, { ...REPORTED, fundingAssetId: null })).rejects.toMatchObject({ code: 'bank.card_funding_not_offered' });
    await expect(ask({ amount: '0' })).rejects.toMatchObject({ code: 'bank.card_funding_invalid' });
    await expect(ask({ amount: '-5' })).rejects.toMatchObject({ code: 'bank.card_funding_invalid' });
    await expect(ask({ threshold: '5' })).rejects.toMatchObject({ code: 'bank.card_funding_invalid' });
    await expect(ask({ reason: 'short' })).rejects.toMatchObject({ code: 'bank.ops_reason_too_short' });
    expect(consumed).toBe(0);
    expect(await sql`SELECT 1 FROM bank.card_programme_funding_requests`).toHaveLength(0);
  });
});
