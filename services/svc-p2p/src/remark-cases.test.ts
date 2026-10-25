import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { P2pErasure } from './erasure.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pError, P2pService } from './p2p-service.js';

/**
 * P-ads-merchant-19 / J-p2p-04 #5: a party to an order reports a sensitive remark in its payment note. A case opens
 * against the other party, one per (order, reporter), and its row is the outbox of the notice that tells them. The remark
 * never travels on the bus; staff read the case. Nothing moves.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const ASSET = 'USDT';
const FIELDS = [{ key: 'account_reference', label: 'Account reference', required: true }];

describe('svc-p2p sensitive-remark cases (P-ads-merchant-19)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let bus!: MemoryEventBus;
  let p2p!: P2pService;
  let tradeId!: string;
  let offerId!: string;
  let ledger!: MemoryLedger;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    const instruments = new InstrumentService(sql);
    bus = new MemoryEventBus('svc-p2p');
    p2p = new P2pService(sql, ledger, bus, {
      instruments,
      feeBps: 0,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    await instruments.registerMethodSchema({ methodId: 'sepa', country: ANY_COUNTRY, label: 'Bank transfer', fields: FIELDS });
    await instruments.createInstrument({
      ownerId: SELLER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'EUR',
      label: 'sepa',
      details: { account_reference: 'ref-sepa' },
      instrumentId: crypto.randomUUID(),
    });
    await ledger.post(
      recipes.deposit({ userId: SELLER, assetId: ASSET, amount: parseAmount('500'), rail: 'test', railRef: `${SELLER}:fund` }),
    );
    const offer = await p2p.createOffer({
      makerId: SELLER,
      side: 'sell',
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('50'),
      totalAmt: parseAmount('500'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });
    offerId = offer.id;
    tradeId = crypto.randomUUID();
    await p2p.takeOffer({ tradeId, offerId: offer.id, takerId: BUYER, amount: parseAmount('20'), method: 'sepa', tier: 'basic' });
    await p2p.markFiatSent(tradeId, BUYER);
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const notices = () => bus.emitted('p2pRemarkCaseOpened');
  const report = (reporterId: string, remark = 'USDT for order', caseId = crypto.randomUUID()) =>
    p2p.reportSensitiveRemark({ caseId, tradeId, reporterId, remark });

  it('opens a case against the other party and tells them once, without the remark', async () => {
    const opened = await report(SELLER, '  crypto payment USDT  ');
    expect(opened).toMatchObject({
      tradeId,
      reporterId: SELLER,
      reportedId: BUYER,
      reporterRole: 'seller',
      remark: 'crypto payment USDT',
      status: 'open',
    });
    expect(notices().map((n) => n.payload)).toEqual([
      { caseId: opened.id, tradeId, reportedId: BUYER, reporterRole: 'seller', openedAt: opened.openedAt.toISOString() },
    ]);
    expect(JSON.stringify(notices())).not.toContain('crypto payment');
    expect(await p2p.listRemarkCases(10)).toEqual([opened]);
  });

  it('answers the same report again with the first case, and refuses a different second one', async () => {
    const caseId = crypto.randomUUID();
    const first = await report(SELLER, 'USDT', caseId);
    expect(await report(SELLER, 'USDT', caseId)).toEqual(first);
    await expect(report(SELLER, 'something else')).rejects.toMatchObject({ code: 'p2p.remark_case_exists' });
    expect(notices()).toHaveLength(1);
    expect(await p2p.listRemarkCases(10)).toHaveLength(1);
  });

  it('lets each party report once, each against the other', async () => {
    await report(SELLER);
    const byBuyer = await report(BUYER, 'P2P');
    expect(byBuyer).toMatchObject({ reporterId: BUYER, reportedId: SELLER, reporterRole: 'buyer' });
    expect(await p2p.listRemarkCases(10)).toHaveLength(2);
  });

  it('answers a stranger as if the order did not exist, and refuses an empty or long remark before any lock', async () => {
    const err = await report(STRANGER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(P2pError);
    expect((err as P2pError).code).toBe('p2p.trade_not_found');
    for (const remark of [' ', 'x'.repeat(281)]) {
      await expect(report(SELLER, remark)).rejects.toMatchObject({ code: 'p2p.remark_invalid' });
    }
    expect(await sql`SELECT 1 FROM p2p.remark_cases`).toHaveLength(0);
    expect(notices()).toHaveLength(0);
  });

  it('refuses a case id already used for another order’s report, and leaves both cases as they were', async () => {
    const first = await report(SELLER);
    const other = crypto.randomUUID();
    await p2p.takeOffer({ tradeId: other, offerId, takerId: STRANGER, amount: parseAmount('20'), method: 'sepa', tier: 'basic' });
    await expect(
      p2p.reportSensitiveRemark({ caseId: first.id, tradeId: other, reporterId: STRANGER, remark: 'USDT' }),
    ).rejects.toMatchObject({ code: 'p2p.remark_case_exists' });
    expect(await p2p.listRemarkCases(10)).toEqual([first]);
    expect(notices()).toHaveLength(1);
  });

  it('refuses a report on an order that was never funded: there is no payment note yet', async () => {
    // The escrow lock's answer is lost, so the order stays created: the buyer was never asked to pay.
    const unfunded = crypto.randomUUID();
    vi.spyOn(ledger, 'post').mockRejectedValueOnce(new Error('lost lock acknowledgement'));
    await expect(
      p2p.takeOffer({ tradeId: unfunded, offerId, takerId: STRANGER, amount: parseAmount('20'), method: 'sepa', tier: 'basic' }),
    ).rejects.toThrow('lost lock acknowledgement');
    expect((await p2p.getTrade(unfunded)).status).toBe('created');
    for (const reporterId of [SELLER, STRANGER]) {
      await expect(
        p2p.reportSensitiveRemark({ caseId: crypto.randomUUID(), tradeId: unfunded, reporterId, remark: 'USDT' }),
      ).rejects.toMatchObject({ code: 'p2p.invalid_transition' });
    }
    expect(await sql`SELECT 1 FROM p2p.remark_cases`).toHaveLength(0);
  });

  it('reads each party their own report in full, and that the other reported them without the quote; a stranger not found', async () => {
    expect(await p2p.remarkCasesOn(tradeId, SELLER)).toEqual({ mine: null, againstMe: null });
    const opened = await report(SELLER);
    expect(await p2p.remarkCasesOn(tradeId, SELLER)).toEqual({ mine: opened, againstMe: null });
    const seen = await p2p.remarkCasesOn(tradeId, BUYER);
    expect(seen).toEqual({ mine: null, againstMe: { caseId: opened.id, openedAt: opened.openedAt } });
    expect(JSON.stringify(seen)).not.toContain(opened.remark);
    await expect(p2p.remarkCasesOn(tradeId, STRANGER)).rejects.toMatchObject({ code: 'p2p.trade_not_found' });
  });

  it('with the bus down the case still opens; the sweep tells the reported party once', async () => {
    const publish = vi.spyOn(bus, 'publish').mockRejectedValueOnce(new Error('bus unavailable'));
    const opened = await report(SELLER);
    publish.mockRestore();
    expect(notices()).toHaveLength(0);
    expect(await p2p.sweepRemarkCases(100)).toEqual({ sent: 1, failures: [] });
    expect(await p2p.sweepRemarkCases(100)).toEqual({ sent: 0, failures: [] });
    expect(notices().map((n) => (n.payload as { caseId: string }).caseId)).toEqual([opened.id]);
  });

  it('exports the case to both parties, the reporter and the reported', async () => {
    const opened = await report(SELLER);
    const erasure = new P2pErasure(sql);
    for (const userId of [SELLER, BUYER]) {
      const exported = await erasure.exportFor(userId);
      expect(exported.remarkCases).toEqual([expect.objectContaining({ id: opened.id, remark: 'USDT for order' })]);
    }
    expect(await p2p.listRemarkCases(10)).toHaveLength(1);
  });
});
