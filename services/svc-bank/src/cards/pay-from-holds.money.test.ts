/**
 * J-bank-29 #3 to #8 (BK-ccrypto-02, BK-ccrypto-03) over real rows: a card payment taken by the person's pay-from order.
 * The TEST partner card walks the order and holds from the first asset that covers the payment, at its own TEST rate; the
 * app records the asset, the amount, the rate and the rate's time as the partner reported them; capture settles at most
 * the hold and the rest goes back to the same asset; a refund is the partner's credit to that asset, once; the founders'
 * reconciliation reads each line against the partner's own report of each hold. The ledger posts nothing anywhere here.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CardService } from './card-service.js';
import { cardSim } from './issuer.js';
import { partnerCardKey, testPartnerCardHolds, type PartnerCardHolds } from './partner-card-holds.js';
import { cardSimPartnerFor, type CardPartnerTerms } from './partner-terms.js';
import { testPartner } from '../partner/test-partner.js';

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

/** The stack's TEST partner card (the bank profile): 30 USDC, 0.01 BTC and 50 USD, 1 BTC quoted at 50000 USDC, 1 USD at 1. */
const PARTNER: CardPartnerTerms = cardSimPartnerFor(
  JSON.stringify({
    custodyMode: 'partner_holds',
    spendFrom: ['USDC', 'BTC', 'USD'],
    lossLiability: null,
    reserve: null,
    funder: null,
    balances: { USDC: '30', BTC: '0.01', USD: '50' },
    programmeFigures: null,
    figuresAsOf: null,
    fundingAssetId: null,
    fundingOffers: null,
    rates: { in: 'USDC', perUnit: { BTC: '50000', USD: '1' } },
  }),
  { APP_ENV: 'test' },
);
const AT = new Date('2026-11-17T08:00:00.000Z');

describe('a card payment by the pay-from order (J-bank-29 #3 to #8, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let holds: PartnerCardHolds;
  let user: string;
  let cardId: string;
  const service = (partnerHolds: PartnerCardHolds | null = holds) =>
    new CardService(sql, ledger, {
      issuer: cardSim({ partner: PARTNER }),
      spendAssets: ['USDC', 'BTC', 'USD'],
      clock: () => AT,
      heldBy: () => 'partner',
      partnerHolds,
    });
  const figures = async (assetId: string) => holds.figures({ userId: user, assetId });
  const pay = (amount: string, ref = `jb29-${randomUUID()}`) =>
    service()
      .authorize({ cardId, authorizationRef: ref, amount: amt(amount) })
      .then((a) => ({ ...a, ref }));

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
    const switches = testPartner();
    holds = testPartnerCardHolds({ terms: () => PARTNER, switches: (u) => switches.switches(u), clock: () => AT });
    user = randomUUID();
    // The journey's card: it draws on USDT (an asset the partner cannot spend from) and settles in USDC.
    const card = await service().issue({
      cardId: randomUUID(),
      userId: user,
      assetId: 'USDT',
      settlementAssetId: 'USDC',
      perAuthorizationLimit: amt('1000'),
    });
    cardId = card.id;
    await service().setPayFromOrder(user, ['USDC', 'BTC', 'USD']);
  });

  it('Pay from shows the partner’s own quote and its time, and none without a partner that quotes', async () => {
    const view = await service().payFrom(user);
    expect(view.assets.filter((a) => a.state === 'offered').map((a) => [a.assetId, a.partnerBalance, a.rate, a.rateAsOf])).toEqual([
      ['USDC', '30', '1', AT.toISOString()],
      ['BTC', '0.01', '50000', AT.toISOString()],
      ['USD', '50', '1', AT.toISOString()],
    ]);
    // The market's price never stands in for the partner's: no partner, no rate.
    for (const row of (await service(null).payFrom(user)).assets) expect(row.rate).toBeNull();
  });

  it('#3 a charge of 25 is held from USDC, the first asset, at the partner’s rate and time; USDC available falls by exactly that', async () => {
    const paid = await pay('25');
    expect(paid).toMatchObject({ decision: 'approved', status: 'settled', heldBy: 'partner', payFromOrder: ['USDC', 'BTC', 'USD'] });
    expect(paid.amount).toBe(amt('25'));
    expect(paid.conversion).toMatchObject({
      settlementAssetId: 'USDC',
      settlementAmount: amt('25'),
      fundingAssetId: 'USDC',
      fundingAmount: amt('25'),
      rate: amt('1'),
      quality: 'partner',
    });
    expect(paid.conversion!.rateAsOf.toISOString()).toBe(AT.toISOString());
    expect(await figures('USDC')).toMatchObject({ available: '5', held: '25' });
    const report = await holds.holdState({ holdKey: partnerCardKey('hold', paid.id) });
    expect(report).toMatchObject({ assetId: 'USDC', amount: '25', conversion: { rate: '1', rateAsOf: AT.toISOString() } });
    expect((await service().payFrom(user)).assets.find((a) => a.assetId === 'USDC')?.partnerBalance).toBe('5');
    expect(ledger.journal()).toHaveLength(0);
  });

  it('#4 a charge of 40, more than the USDC left, is one BTC hold at 50000; USDC is unchanged', async () => {
    await pay('25');
    const btc = await pay('40');
    expect(btc).toMatchObject({ decision: 'approved', status: 'settled' });
    expect(btc.conversion).toMatchObject({ fundingAssetId: 'BTC', fundingAmount: amt('0.0008'), rate: amt('50000'), quality: 'partner' });
    expect(btc.amount).toBe(amt('0.0008'));
    expect(await figures('USDC')).toMatchObject({ available: '5', held: '25' });
    expect(await figures('BTC')).toMatchObject({ available: '0.0092', held: '0.0008' });
    expect(await figures('USD')).toMatchObject({ available: '50', held: '0' });
    // A redelivery returns the first decision and holds nothing more.
    const again = await service().authorize({ cardId, authorizationRef: btc.ref, amount: amt('40') });
    expect(again.id).toBe(btc.id);
    expect(await figures('BTC')).toMatchObject({ available: '0.0092', held: '0.0008' });
  });

  it('#5 a charge no one asset covers is the partner’s decline bank.card_insufficient_funds, naming the order; nothing held', async () => {
    await pay('25');
    await pay('40');
    const before = await Promise.all(['USDC', 'BTC', 'USD'].map(figures));
    const declined = await pay('500');
    expect(declined).toMatchObject({
      decision: 'declined',
      declineCode: 'bank.card_insufficient_funds',
      status: 'rejected',
      payFromOrder: ['USDC', 'BTC', 'USD'],
      conversion: null,
    });
    expect(await Promise.all(['USDC', 'BTC', 'USD'].map(figures))).toEqual(before);
    expect(ledger.journal()).toHaveLength(0);
  });

  it('#6 #7 capture 22 of 25 settles 22 USDC and returns 3; a refund of 10 credits USDC once, and its repeat changes nothing', async () => {
    const first = await pay('25');
    const captured = await service().capture({ cardId, authorizationRef: first.ref, amount: amt('22') });
    expect(captured).toMatchObject({ heldBy: 'partner', captured: amt('22'), returned: amt('3') });
    expect(await figures('USDC')).toMatchObject({ available: '8', held: '0' });
    // Never more than it held.
    const second = await pay('5');
    await expect(service().capture({ cardId, authorizationRef: second.ref, amount: amt('5.01') })).rejects.toMatchObject({
      code: 'bank.card_capture_exceeds_authorization',
    });
    const feed = await service().authorizationsOf(cardId, 50);
    expect(feed.find((r) => r.id === first.id)?.settled).toEqual({ captured: amt('22'), returned: amt('3') });

    const refund = await service().refund({ cardId, authorizationRef: first.ref, amount: amt('10') });
    expect(refund.refunded).toBe(amt('10'));
    const repeat = await service().refund({ cardId, authorizationRef: first.ref, amount: amt('10') });
    expect(repeat.partnerRef).toBe(refund.partnerRef);
    // 8 after the capture, less the 5 still held for the second payment, plus the one refund of 10.
    expect(await figures('USDC')).toMatchObject({ available: '13', held: '5' });
    expect(ledger.journal()).toHaveLength(0);
  });

  it('a BTC refund credits BTC at the rate it was held at, rounded down', async () => {
    await pay('25');
    const btc = await pay('40');
    await service().capture({ cardId, authorizationRef: btc.ref, amount: amt('40') });
    const refund = await service().refund({ cardId, authorizationRef: btc.ref, amount: amt('10') });
    expect(refund.refunded).toBe(amt('0.0002'));
    expect(await figures('BTC')).toMatchObject({ available: '0.0094' });
  });

  it('#8 the reconciliation reads every line "matches" against the partner, and a hold it has no record of is a break row', async () => {
    const first = await pay('25');
    await service().capture({ cardId, authorizationRef: first.ref, amount: amt('22') });
    await service().refund({ cardId, authorizationRef: first.ref, amount: amt('10') });
    await pay('40');
    const view = await service().payFromReconciliation();
    const mine = (lines: typeof view.lines) => lines.filter((l) => ['USDC', 'BTC'].includes(l.assetId));
    expect(mine(view.lines)).toEqual(
      expect.arrayContaining([
        { assetId: 'USDC', kind: 'spend', app: amt('12'), partner: amt('12'), status: 'matches' },
        { assetId: 'USDC', kind: 'open_holds', app: 0n, partner: 0n, status: 'matches' },
        { assetId: 'BTC', kind: 'spend', app: 0n, partner: 0n, status: 'matches' },
        { assetId: 'BTC', kind: 'open_holds', app: amt('0.0008'), partner: amt('0.0008'), status: 'matches' },
      ]),
    );
    expect(view.breaks.filter((b) => [first.ref].includes(b.authorizationRef))).toEqual([]);

    // A partner that has forgotten every hold (a TEST restart): each payment is its own break row, and no line sums it.
    const forgetful = testPartnerCardHolds({ terms: () => PARTNER, switches: () => testPartner().switches(user), clock: () => AT });
    const broken = await service(forgetful).payFromReconciliation();
    expect(broken.breaks.find((b) => b.authorizationRef === first.ref)).toMatchObject({ reason: 'not_reported', partner: null });
  });

  it('a partner answer for another amount or an asset outside the order is refused, and the row stays pending', async () => {
    const lying: PartnerCardHolds = {
      ...holds,
      holdInOrder: async (input) => {
        const real = await holds.holdInOrder!(input);
        if (!real.approved) return real;
        return { ...real, hold: { ...real.hold, assetId: 'USDT' } };
      },
    };
    const ref = `jb29-${randomUUID()}`;
    await expect(service(lying).authorize({ cardId, authorizationRef: ref, amount: amt('25') })).rejects.toMatchObject({
      code: 'bank.card_partner_key_conflict',
    });
    const [row] = await sql<Array<{ status: string }>>`SELECT status FROM bank.card_authorizations WHERE authorization_ref = ${ref}`;
    expect(row?.status).toBe('pending');
    // A redelivery to the honest partner re-sends the same key and records its first answer.
    const redriven = await service().authorize({ cardId, authorizationRef: ref, amount: amt('25') });
    expect(redriven).toMatchObject({ decision: 'approved', status: 'settled' });
    expect(await figures('USDC')).toMatchObject({ available: '5', held: '25' });
  });
});
