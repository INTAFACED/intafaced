import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { contractUnitsOf, P2pError, P2pService, type ContractDealRead } from './p2p-service.js';

/**
 * RC-p2p-02 (J-p2p-21): a contract-escrow order beside the ledger escrow. The seller's coins sit in the SovereignEscrow
 * contract; this service records the deal, checks it against the order, and follows its chain state. Invariant: a
 * contract order never reaches the ledger, through any door (take, release, cancel, dispute, sweep, settle).
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDC';
const TOKEN = '0x000000000000000000000000000000000000d011';
const BUYER_WALLET = '0x2222222222222222222222222222222222222222';
const SELLER_WALLET = '0x3333333333333333333333333333333333333333';
const CHAIN = 84532;
const WINDOW = 300;
const CONTRACT = { chainId: CHAIN, token: TOKEN, decimals: 6, buyerWallet: BUYER_WALLET, disputeWindowSeconds: WINDOW };

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as P2pError).code;
}

describe('svc-p2p contract escrow (RC-p2p-02, J-p2p-21)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let posts: string[];
  let p2p!: P2pService;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'p2p', url: process.env.TEST_DATABASE_URL, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await db!.truncateAll();
    ledger = new MemoryLedger();
    posts = [];
    // Every post the service sends, by its business key: a contract order must add none.
    const counting = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop === 'post')
          return (tx: Parameters<LedgerClient['post']>[0]) => {
            posts.push(tx.idempotencyKey);
            return target.post(tx);
          };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as LedgerClient;
    const instruments = new InstrumentService(sql);
    p2p = new P2pService(sql, counting, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 30,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Test rail',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    for (const owner of [SELLER, BUYER])
      await instruments.createInstrument({
        ownerId: owner,
        methodId: 'sepa',
        country: 'DE',
        fiatCurrency: 'EUR',
        label: 'sepa',
        details: { account_reference: `ref-${owner}` },
        instrumentId: crypto.randomUUID(),
      });
    for (const owner of [SELLER, BUYER])
      await ledger.post(
        recipes.deposit({ userId: owner, assetId: ASSET, amount: parseAmount('500'), rail: 'test', railRef: `${owner}:fund` }),
      );
    posts = [];
  });

  const offer = (side: 'sell' | 'buy' = 'sell', makerId = SELLER) =>
    p2p.createOffer({
      makerId,
      side,
      asset: ASSET,
      fiatCurrency: 'EUR',
      priceType: 'fixed',
      price: parseAmount('0.92'),
      minAmt: parseAmount('10'),
      maxAmt: parseAmount('20'),
      totalAmt: parseAmount('200'),
      methods: ['sepa'],
      terms: 'TEST terms',
    });

  const takeContract = async (offerId: string, takerId = BUYER) =>
    p2p.takeOffer({
      tradeId: crypto.randomUUID(),
      offerId,
      takerId,
      amount: parseAmount('20'),
      method: 'sepa',
      tier: 'basic',
      contract: CONTRACT,
    });

  const deal = (over: Partial<ContractDealRead> = {}): ContractDealRead => ({
    dealId: '7',
    chainId: CHAIN,
    seller: SELLER_WALLET,
    buyer: BUYER_WALLET,
    token: TOKEN,
    amount: '20000000',
    arbiter: null,
    disputeWindowSeconds: WINDOW,
    disputeDeadline: null,
    timeout: 'refund_seller',
    state: 'locked',
    ...over,
  });

  it('a contract take holds nothing in the ledger and waits for the seller to fund the deal', async () => {
    const { id } = await offer();
    const trade = await takeContract(id);
    expect(trade).toMatchObject({ status: 'created', escrowKind: 'contract', feeBps: 0 });
    expect(trade.contract).toMatchObject({ chainId: CHAIN, token: TOKEN, units: '20000000', buyerWallet: BUYER_WALLET, dealId: null });
    expect(posts).toEqual([]);
  });

  it('a ledger take is unchanged: one escrowLock under p2p.escrow.lock:<tradeId>', async () => {
    const { id } = await offer();
    const trade = await p2p.takeOffer({
      tradeId: crypto.randomUUID(),
      offerId: id,
      takerId: BUYER,
      amount: parseAmount('20'),
      method: 'sepa',
      tier: 'basic',
    });
    expect(trade).toMatchObject({ status: 'escrowed', escrowKind: 'ledger', contract: null });
    expect(posts).toEqual([`p2p.escrow.lock:${trade.id}`]);
  });

  it('the contract escrow is the buyer’s choice on a sell ad; a seller taking a buy ad is refused', async () => {
    const { id } = await offer('buy', BUYER);
    expect(await refusal(takeContract(id, SELLER))).toBe('p2p.contract_escrow_unavailable');
    expect(posts).toEqual([]);
  });

  it('attaches only a locked deal carrying exactly the order’s terms, once', async () => {
    const { id } = await offer();
    const trade = await takeContract(id);
    const attach = (d: ContractDealRead, actorId = SELLER) => p2p.attachContractDeal({ tradeId: trade.id, actorId, deal: d });
    expect(await refusal(attach(deal(), BUYER))).toBe('p2p.not_the_seller');
    for (const wrong of [
      { amount: '19000000' },
      { buyer: SELLER_WALLET },
      { token: '0x000000000000000000000000000000000000beef' },
      { chainId: 1 },
      { arbiter: SELLER_WALLET },
      { disputeWindowSeconds: 60 },
      { timeout: 'release_buyer' as const },
      { state: 'open' as const },
    ])
      expect(await refusal(attach(deal(wrong)))).toBe('p2p.escrow_deal_mismatch');
    const escrowed = await attach(deal());
    expect(escrowed).toMatchObject({ status: 'escrowed', contract: { dealId: '7', sellerWallet: SELLER_WALLET } });
    expect((await attach(deal())).status).toBe('escrowed');
    expect(await refusal(attach(deal({ dealId: '8' })))).toBe('p2p.escrow_deal_mismatch');
    expect(posts).toEqual([]);
  });

  it('one deal backs one order', async () => {
    const { id } = await offer();
    const first = await takeContract(id);
    await p2p.attachContractDeal({ tradeId: first.id, actorId: SELLER, deal: deal() });
    const second = await takeContract(id);
    expect(await refusal(p2p.attachContractDeal({ tradeId: second.id, actorId: SELLER, deal: deal() }))).toBe('p2p.escrow_deal_mismatch');
  });

  it('after the buyer marks paid the seller cannot cancel, and no ledger door moves a contract order', async () => {
    const { id } = await offer();
    const trade = await takeContract(id);
    await p2p.attachContractDeal({ tradeId: trade.id, actorId: SELLER, deal: deal() });
    expect((await p2p.markFiatSent(trade.id, BUYER)).status).toBe('fiat_sent');
    expect(await refusal(p2p.cancelTrade(trade.id, SELLER))).toBe('p2p.cancel_after_paid');
    expect(await refusal(p2p.confirmFiatReceived(trade.id, SELLER))).toBe('p2p.escrow_contract_held');
    expect(await refusal(p2p.openDispute({ tradeId: trade.id, openedBy: SELLER }))).toBe('p2p.escrow_contract_held');
    expect(await refusal(p2p.settle(trade.id))).toBe('p2p.escrow_missing');
    expect((await p2p.getTrade(trade.id)).status).toBe('fiat_sent');
    expect(posts).toEqual([]);
  });

  it('the contract’s release completes the order once, with no ledger post', async () => {
    const { id } = await offer();
    const trade = await takeContract(id);
    await p2p.attachContractDeal({ tradeId: trade.id, actorId: SELLER, deal: deal() });
    await p2p.markFiatSent(trade.id, BUYER);
    expect((await p2p.syncContractDeal({ tradeId: trade.id, actorId: BUYER, deal: deal() })).status).toBe('fiat_sent');
    const released = await p2p.syncContractDeal({ tradeId: trade.id, actorId: BUYER, deal: deal({ state: 'released' }) });
    expect(released).toMatchObject({ status: 'released', resolution: 'released' });
    expect(released.settledAt).not.toBeNull();
    const again = await p2p.syncContractDeal({ tradeId: trade.id, actorId: SELLER, deal: deal({ state: 'released' }) });
    expect(again.resolvedAt?.toISOString()).toBe(released.resolvedAt?.toISOString());
    expect(posts).toEqual([]);
  });

  it('the contract’s refund cancels the order and puts the amount back on the ad', async () => {
    const created = await offer();
    const trade = await takeContract(created.id);
    await p2p.attachContractDeal({ tradeId: trade.id, actorId: SELLER, deal: deal() });
    const refunded = await p2p.syncContractDeal({ tradeId: trade.id, actorId: SELLER, deal: deal({ state: 'refunded' }) });
    expect(refunded).toMatchObject({ status: 'cancelled', resolution: 'refunded' });
    expect((await p2p.getOffer(created.id, SELLER)).remainingAmt).toBe(parseAmount('200'));
    expect(posts).toEqual([]);
  });

  it('the contract’s dispute disputes the order with the contract’s deadline; the coins stay in the contract', async () => {
    const { id } = await offer();
    const trade = await takeContract(id);
    await p2p.attachContractDeal({ tradeId: trade.id, actorId: SELLER, deal: deal() });
    await p2p.markFiatSent(trade.id, BUYER);
    const deadline = Math.floor(Date.now() / 1000) + WINDOW;
    const disputed = await p2p.syncContractDeal({
      tradeId: trade.id,
      actorId: SELLER,
      deal: deal({ state: 'disputed', disputeDeadline: deadline }),
    });
    expect(disputed).toMatchObject({ status: 'disputed', resolution: null });
    expect(disputed.deadlineAt?.getTime()).toBe(deadline * 1000);
    expect(posts).toEqual([]);
  });

  it('the sweep voids an unfunded contract order with no ledger call and never touches a funded one', async () => {
    const { id } = await offer();
    const unfunded = await takeContract(id);
    const funded = await takeContract(id);
    await p2p.attachContractDeal({ tradeId: funded.id, actorId: SELLER, deal: deal() });
    const result = await p2p.sweepDeadlines(new Date(Date.now() + 86_400_000), 50);
    expect(result.failures.map((f) => JSON.stringify(f))).toEqual([]);
    expect(await p2p.getTrade(unfunded.id)).toMatchObject({ status: 'cancelled', resolution: 'voided' });
    expect((await p2p.getTrade(funded.id)).status).toBe('escrowed');
    expect(posts).toEqual([]);
  });

  it('the escrow kind and the deal’s terms cannot change after take (database trigger)', async () => {
    const { id } = await offer();
    const trade = await takeContract(id);
    await expect(sql`UPDATE p2p.p2p_trades SET escrow_kind = 'ledger' WHERE id = ${trade.id}`).rejects.toThrow(
      /escrow_kind_immutable|contract_terms/,
    );
    await expect(sql`UPDATE p2p.p2p_trades SET contract_units = 1 WHERE id = ${trade.id}`).rejects.toThrow(/escrow_kind_immutable/);
    await expect(sql`UPDATE p2p.p2p_trades SET escrow_lock_attempts = 1 WHERE id = ${trade.id}`).rejects.toThrow(/contract_no_ledger/);
  });

  it('an order finer than the token’s decimals refuses', () => {
    expect(contractUnitsOf(parseAmount('20.5'), 6)).toBe('20500000');
    expect(() => contractUnitsOf(parseAmount('0.0000001'), 6)).toThrow(/decimal places/);
  });
});
