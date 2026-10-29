import { beforeEach, describe, expect, it } from 'vitest';
import { houseFees, orderHoldAccount, rewardsEngine, userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError, LedgerError } from '../types.js';
import { buybackOrderHoldAccount, type BuybackTakerFillInput } from './buyback.js';
import { recipes } from './index.js';

/**
 * The token buyback's IOC buy (J-dex-protocol-17). TEST amounts, worked by hand, not recomputed in the assertion.
 *
 * Funding: a customer pays a 100 USDT trade fee, and the fee share is swept into the rewards engine by the existing
 * `sweepFeesToRewards`. A customer maker rests an ask of 50 IFC. The buyback holds 100 USDT for its IOC order and
 * buys 40 IFC for 80 USDT at a 10 bps maker fee: the maker receives 79.92 USDT, the house keeps 0.08, and 40 IFC
 * land in the rewards engine. 20 USDT are unfilled and go back.
 */

const PAYER = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';
const QUOTE = 'USDT';
const BASE = 'IFC';
const ORDER = 'bb-order-1';
const ASK = 'ask-1';

let ledger: MemoryLedger;

async function bal(account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

/** Real funding path: a fee into houseFees(trade), swept into the rewards engine; and a maker's resting ask. */
async function fund(fee = '100', ask = '50'): Promise<void> {
  await ledger.post(recipes.deposit({ userId: PAYER, assetId: QUOTE, amount: amt(fee), rail: 'crypto-native', railRef: 'tx-fee' }));
  await ledger.post(recipes.feeCharge({ chargeId: 'c1', userId: PAYER, module: 'trade', mode: 'asset', assetId: QUOTE, amount: amt(fee) }));
  await ledger.post(recipes.sweepFeesToRewards({ windowId: 'buyback:run-1', sourceModule: 'trade', assetId: QUOTE, amount: amt(fee) }));
  await ledger.post(recipes.deposit({ userId: MAKER, assetId: BASE, amount: amt(ask), rail: 'crypto-native', railRef: 'tx-ask' }));
  await ledger.post(recipes.orderHold({ orderId: ASK, userId: MAKER, assetId: BASE, amount: amt(ask) }));
}

const hold = (amount = '100', orderId = ORDER) => recipes.buybackOrderHold({ orderId, quoteAsset: QUOTE, amount: amt(amount) });
const release = (amount: string, sequence?: number, orderId = ORDER) =>
  recipes.buybackOrderHoldRelease({ orderId, quoteAsset: QUOTE, amount: amt(amount), ...(sequence === undefined ? {} : { sequence }) });
const fillInput = (over: Partial<BuybackTakerFillInput> = {}): BuybackTakerFillInput => ({
  fillId: 'f1',
  makerId: MAKER,
  makerOrderId: ASK,
  takerOrderId: ORDER,
  baseAsset: BASE,
  quoteAsset: QUOTE,
  qty: amt('40'),
  quoteAmount: amt('80'),
  makerFeeBps: 10,
  ...over,
});
const fill = (over: Partial<BuybackTakerFillInput> = {}) => recipes.buybackTakerFill(fillInput(over));

async function snapshot() {
  return {
    rewardsQuote: await bal(rewardsEngine(QUOTE)),
    held: await bal(buybackOrderHoldAccount(QUOTE, ORDER)),
    makerQuote: await bal(userAvailable(MAKER, QUOTE)),
    fees: await bal(houseFees('trade', QUOTE)),
    ask: await bal(orderHoldAccount(MAKER, BASE, ASK)),
    rewardsBase: await bal(rewardsEngine(BASE)),
  };
}

beforeEach(() => {
  ledger = new MemoryLedger();
});

describe('token buyback IOC buy', () => {
  it('holds the swept quote, buys from a customer ask into the rewards engine, and returns the remainder', async () => {
    await fund();
    await ledger.post(hold('100'));
    expect(await snapshot()).toEqual({ rewardsQuote: '0', held: '100', makerQuote: '0', fees: '0', ask: '50', rewardsBase: '0' });

    await ledger.post(fill());
    expect(await snapshot()).toEqual({
      rewardsQuote: '0',
      held: '20',
      makerQuote: '79.92',
      fees: '0.08',
      ask: '10',
      rewardsBase: '40',
    });

    await ledger.post(release('20'));
    expect(await snapshot()).toEqual({
      rewardsQuote: '20',
      held: '0',
      makerQuote: '79.92',
      fees: '0.08',
      ask: '10',
      rewardsBase: '40',
    });

    // svc-token's settle burns from the rewards engine: the bought base is there to burn.
    await ledger.post(recipes.burn({ runId: 'run-1', assetId: BASE, amount: amt('40'), from: rewardsEngine(BASE) }));
    expect(await bal(rewardsEngine(BASE))).toBe('0');
    expect(ledger.totalsByAsset()).toEqual({ [QUOTE]: '0', [BASE]: '0' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('posts each step once under its business key, including on a retry', async () => {
    await fund();
    const first = await ledger.post(hold('100'));
    expect((await ledger.post(hold('100'))).id).toBe(first.id);
    const filled = await ledger.post(fill());
    expect((await ledger.post(fill())).id).toBe(filled.id);
    const released = await ledger.post(release('20'));
    expect((await ledger.post(release('20'))).id).toBe(released.id);
    expect(await snapshot()).toMatchObject({ rewardsQuote: '20', held: '0', makerQuote: '79.92', rewardsBase: '40' });
    expect(hold('100').idempotencyKey).toBe(`order.hold.buyback:${ORDER}`);
    expect(fill().idempotencyKey).toBe('trade.fill.buyback:f1');
    expect(release('20').idempotencyKey).toBe(`order.release.buyback:${ORDER}:0`);
    expect(release('20', 2).idempotencyKey).toBe(`order.release.buyback:${ORDER}:2`);
  });

  it('a second fill of the same order draws only what is still held', async () => {
    await fund();
    await ledger.post(hold('100'));
    await ledger.post(fill());
    await expect(ledger.post(fill({ fillId: 'f2', qty: amt('10'), quoteAmount: amt('20.01') }))).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    await ledger.post(fill({ fillId: 'f2', qty: amt('10'), quoteAmount: amt('20') }));
    expect(await snapshot()).toMatchObject({ held: '0', ask: '0', rewardsBase: '50' });
  });

  describe('refused, and the book is untouched', () => {
    it('a hold larger than the rewards engine holds', async () => {
      await fund('100');
      const before = await snapshot();
      await expect(ledger.post(hold('100.01'))).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await snapshot()).toEqual(before);
    });

    it('a fill that pays more quote than the order holds', async () => {
      await fund('100', '100');
      await ledger.post(hold('50'));
      const before = await snapshot();
      await expect(ledger.post(fill({ qty: amt('40'), quoteAmount: amt('80') }))).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await snapshot()).toEqual(before);
    });

    it('a fill that takes more base than the ask holds', async () => {
      await fund('100', '30');
      await ledger.post(hold('100'));
      const before = await snapshot();
      await expect(ledger.post(fill())).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await snapshot()).toEqual(before);
    });

    it('a fill against an order that was never held', async () => {
      await fund();
      const before = await snapshot();
      await expect(ledger.post(fill())).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await snapshot()).toEqual(before);
    });

    it('a release of more than is left, and a release after the order is spent', async () => {
      await fund();
      await ledger.post(hold('100'));
      await ledger.post(fill());
      const before = await snapshot();
      await expect(ledger.post(release('20.01'))).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await snapshot()).toEqual(before);
      await ledger.post(release('20'));
      const spent = await snapshot();
      await expect(ledger.post(release('1', 1))).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await snapshot()).toEqual(spent);
    });
  });

  it('a zero maker fee posts no house leg', async () => {
    const post = fill({ makerFeeBps: 0 });
    expect(post.entries).toHaveLength(4);
    expect(post.entries.some((e) => e.account.ownerId === 'fees:trade')).toBe(false);
    await fund();
    await ledger.post(hold('100'));
    await ledger.post(post);
    expect(await snapshot()).toMatchObject({ makerQuote: '80', fees: '0', rewardsBase: '40' });
  });

  it('refuses a fee that eats the whole receivable', () => {
    // 10 bps of one smallest unit rounds up to that unit: the maker would receive nothing.
    expect(() => fill({ quoteAmount: 1n })).toThrow(InvalidEntryError);
    expect(() => fill({ makerFeeBps: 10_000 })).toThrow(InvalidEntryError);
  });

  it('refuses blank, padded or invalid input before any post', () => {
    for (const bad of [
      () => hold('0'),
      () => hold('-1'),
      () => hold('1', ''),
      () => hold('1', ' bb '),
      () => release('0'),
      () => release('1', -1),
      () => release('1', 1.5),
      () => release('1', 0, ''),
      () => fill({ fillId: '' }),
      () => fill({ fillId: ' f1' }),
      () => fill({ makerId: '' }),
      () => fill({ makerOrderId: '' }),
      () => fill({ takerOrderId: '' }),
      () => fill({ qty: 0n }),
      () => fill({ quoteAmount: 0n }),
      () => fill({ makerFeeBps: -1 }),
      () => fill({ makerFeeBps: 1.5 }),
      () => fill({ baseAsset: QUOTE }),
    ]) {
      expect(bad).toThrow(InvalidEntryError);
    }
    expect(() => buybackOrderHoldAccount(QUOTE, '')).toThrow(InvalidEntryError);
  });

  it('invariant: random holds, fills and releases never strand, mint or overdraw value', async () => {
    let seed = 0x5eed;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const posted = [0, 0, 0];
    const refused = [0, 0, 0];

    for (let run = 0; run < 30; run += 1) {
      ledger = new MemoryLedger();
      await fund('1000', '500');
      const orders = ['o1', 'o2', 'o3'];
      const fills = new Map<string, number>();
      const releases = new Map<string, number>();
      for (let step = 0; step < 25; step += 1) {
        const kind = next(3);
        const orderId = orders[next(orders.length)]!;
        const amount = String(1 + next(400));
        try {
          if (kind === 0) {
            await ledger.post(hold(amount, orderId));
          } else if (kind === 1) {
            const n = (fills.get(orderId) ?? 0) + 1;
            const qty = String(1 + next(100));
            await ledger.post(
              fill({
                fillId: `${run}:${orderId}:${n}`,
                takerOrderId: orderId,
                qty: amt(qty),
                quoteAmount: amt(amount),
                makerFeeBps: next(50),
              }),
            );
            fills.set(orderId, n);
          } else {
            const n = releases.get(orderId) ?? 0;
            await ledger.post(release(amount, n, orderId));
            releases.set(orderId, n + 1);
          }
          posted[kind]! += 1;
        } catch (err) {
          // A refused post moves nothing; the checks below prove it.
          // Every refusal is the ledger's own: an overdraw, a bad input, or a reused key with another body.
          expect(err).toBeInstanceOf(LedgerError);
          refused[kind]! += 1;
        }

        expect(ledger.totalsByAsset()).toEqual({ [QUOTE]: '0', [BASE]: '0' });
        expect(ledger.reconcile()).toEqual({ ok: true });
        let quote = 0n;
        for (const account of [
          rewardsEngine(QUOTE),
          userAvailable(MAKER, QUOTE),
          houseFees('trade', QUOTE),
          ...orders.map((o) => buybackOrderHoldAccount(QUOTE, o)),
        ]) {
          const a = (await ledger.balance(account)).amount;
          expect(a >= 0n).toBe(true);
          quote += a;
        }
        let base = 0n;
        for (const account of [orderHoldAccount(MAKER, BASE, ASK), rewardsEngine(BASE)]) {
          const a = (await ledger.balance(account)).amount;
          expect(a >= 0n).toBe(true);
          base += a;
        }
        // Every swept unit and every unit of the ask is in exactly one of these accounts.
        expect(formatAmount(quote)).toBe('1000');
        expect(formatAmount(base)).toBe('500');
      }
    }
    for (const kind of [0, 1, 2]) {
      expect(posted[kind]).toBeGreaterThan(0);
      expect(refused[kind]).toBeGreaterThan(0);
    }
  });
});
