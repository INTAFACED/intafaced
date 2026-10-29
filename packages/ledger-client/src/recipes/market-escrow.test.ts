import { describe, expect, it } from 'vitest';
import { houseFees, userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { MarketReleaseRemainderError, marketPurchaseEscrowAccount } from './market-escrow.js';

const BUYER = '11111111-1111-4111-8111-111111111111';
const SELLER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';
const PURCHASE = 'p1';

async function bal(ledger: MemoryLedger, account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

async function funded(amount = '100'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: BUYER, assetId: ASSET, amount: amt(amount), rail: 'crypto-native', railRef: 'tx-1' }));
  return ledger;
}

const base = (amount: string, purchaseId = PURCHASE) => ({
  purchaseId,
  listingId: 'l1',
  buyerId: BUYER,
  assetId: ASSET,
  amount: amt(amount),
});
const hold = (amount = '40', purchaseId = PURCHASE) => recipes.marketPurchaseHold(base(amount, purchaseId));
const refund = (amount: string, refundNo: number, purchaseId = PURCHASE) =>
  recipes.marketPurchaseRefund({ ...base(amount, purchaseId), refundNo });
const release = (amount: string, commissionBps = 1_000, purchaseId = PURCHASE, held = amount, refunded = '0') =>
  recipes.marketPurchaseRelease({
    ...base(amount, purchaseId),
    heldAmount: amt(held),
    refundedAmount: amt(refunded),
    vendorUserId: SELLER,
    commissionBps,
  });

async function snapshot(ledger: MemoryLedger, purchaseId = PURCHASE) {
  return {
    buyer: await bal(ledger, userAvailable(BUYER, ASSET)),
    held: await bal(ledger, marketPurchaseEscrowAccount(BUYER, ASSET, purchaseId)),
    seller: await bal(ledger, userAvailable(SELLER, ASSET)),
    house: await bal(ledger, houseFees('market', ASSET)),
  };
}

describe('market purchase held until its refund window ends', () => {
  it('hold charges the buyer into the purchase pot once under market:hold:<purchase>; the seller sees nothing', async () => {
    const ledger = await funded();
    const post = hold();
    expect(post.idempotencyKey).toBe('market:hold:p1');
    expect(marketPurchaseEscrowAccount(BUYER, ASSET, 'p1')).toMatchObject({ kind: 'escrow', purpose: 'market:purchase:p1' });
    await ledger.post(post);
    await ledger.post(post);
    expect(await snapshot(ledger)).toEqual({ buyer: '60', held: '40', seller: '0', house: '0' });
  });

  it('refuses a hold larger than the buyer available balance and moves nothing', async () => {
    const ledger = await funded('10');
    await expect(ledger.post(hold('40'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await snapshot(ledger)).toEqual({ buyer: '10', held: '0', seller: '0', house: '0' });
  });

  it('a refund returns the amount to the buyer once under market:refund:<purchase>:<n>', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    const post = refund('40', 1);
    expect(post.idempotencyKey).toBe('market:refund:p1:1');
    await ledger.post(post);
    await ledger.post(post);
    expect(await snapshot(ledger)).toEqual({ buyer: '100', held: '0', seller: '0', house: '0' });
  });

  it('a second numbered refund cannot return more than is held, and moves nothing', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    await ledger.post(refund('40', 1));
    await expect(ledger.post(refund('1', 2))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await snapshot(ledger)).toEqual({ buyer: '100', held: '0', seller: '0', house: '0' });
  });

  it('release pays the seller net and the house commission once under market:release:<purchase>', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    const post = release('40', 1_000);
    expect(post.idempotencyKey).toBe('market:release:p1');
    await ledger.post(post);
    await ledger.post(post);
    expect(await snapshot(ledger)).toEqual({ buyer: '60', held: '0', seller: '36', house: '4' });
  });

  it('a refund after the release is refused by the empty pot and moves nothing', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    await ledger.post(release('40'));
    await expect(ledger.post(refund('40', 1))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await snapshot(ledger)).toEqual({ buyer: '60', held: '0', seller: '36', house: '4' });
  });

  it('a partial refund then a release of the rest splits only what was left', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    await ledger.post(refund('15', 1));
    await ledger.post(release('25', 1_000, PURCHASE, '40', '15'));
    // 25 at 10% floors to 2.5 commission; seller 22.5.
    expect(await snapshot(ledger)).toEqual({ buyer: '75', held: '0', seller: '22.5', house: '2.5' });
  });

  it('a release that would leave a remainder in the pot is refused before any post', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    expect(() => release('25', 1_000, PURCHASE, '40', '0')).toThrow(MarketReleaseRemainderError);
    expect(() => release('40', 1_000, PURCHASE, '40', '15')).toThrow(MarketReleaseRemainderError);
    expect(() => release('25', 1_000, PURCHASE, '40', '-15')).toThrow(/refunded amount must be zero or more/);
    expect(() => release('25', 1_000, PURCHASE, '0', '0')).toThrow(/held amount must be positive/);
    expect(await snapshot(ledger)).toEqual({ buyer: '60', held: '40', seller: '0', house: '0' });
  });

  it('the pot helper names the same pot the recipes post to, whatever the spacing', async () => {
    const ledger = await funded();
    await ledger.post(recipes.marketPurchaseHold({ ...base('40'), purchaseId: ' p1 ' }));
    expect(await bal(ledger, marketPurchaseEscrowAccount(BUYER, ASSET, ' p1 '))).toBe('40');
    expect(() => marketPurchaseEscrowAccount(BUYER, ASSET, ' ')).toThrow(InvalidEntryError);
  });

  it('a release with no commission posts no house leg', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    const post = release('40', 0);
    expect(post.entries).toHaveLength(2);
    await ledger.post(post);
    expect(await snapshot(ledger)).toEqual({ buyer: '60', held: '0', seller: '40', house: '0' });
  });

  it('refuses blank or invalid input before any post', () => {
    expect(() => recipes.marketPurchaseHold({ ...base('40'), purchaseId: ' ' })).toThrow(InvalidEntryError);
    expect(() => recipes.marketPurchaseHold({ ...base('40'), buyerId: '' })).toThrow(/buyerId is required/);
    expect(() => recipes.marketPurchaseHold({ ...base('40'), listingId: '' })).toThrow(/listingId is required/);
    expect(() => recipes.marketPurchaseHold(base('0'))).toThrow(/must be positive/);
    expect(() => refund('-1', 1)).toThrow(/must be positive/);
    for (const refundNo of [0, -1, 1.5, Number.NaN]) {
      expect(() => refund('1', refundNo)).toThrow(/refundNo must be a whole number/);
    }
    expect(() => release('40', -1)).toThrow(/commissionBps must be an integer/);
    expect(() => release('40', 10_000)).toThrow(/commissionBps must be an integer/);
    expect(() => release('40', 0.5)).toThrow(/commissionBps must be an integer/);
    const whole = { ...base('40'), heldAmount: amt('40'), refundedAmount: 0n, commissionBps: 100 };
    expect(() => recipes.marketPurchaseRelease({ ...whole, vendorUserId: undefined as unknown as string })).toThrow(
      /vendorUserId is required/,
    );
    expect(() => recipes.marketPurchaseRelease({ ...whole, vendorUserId: BUYER })).toThrow(/buyer and vendor must be different/);
    expect(() => release('0.00000001', 9_999)).not.toThrow();
  });

  it('invariant: across any sequence of holds, refunds and releases, value is conserved and no pot goes negative', async () => {
    // Deterministic pseudo-random sequences (no clock, no Math.random) so a failure replays.
    let seed = 7;
    const posted = [0, 0, 0];
    const refused = [0, 0, 0];
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let round = 0; round < 40; round += 1) {
      const ledger = await funded('1000');
      const ids = ['a', 'b', 'c'];
      const refundNo = new Map<string, number>();
      // What svc-market would record: the held amount and the refunds that posted.
      const heldBy = new Map<string, bigint>();
      const refundedBy = new Map<string, bigint>();
      for (let step = 0; step < 25; step += 1) {
        const id = ids[next(ids.length)]!;
        const amount = String(1 + next(60));
        const kind = next(3);
        try {
          if (kind === 0) {
            await ledger.post(hold(amount, id));
            if (!heldBy.has(id)) heldBy.set(id, amt(amount));
          } else if (kind === 1) {
            const n = (refundNo.get(id) ?? 0) + 1;
            await ledger.post(refund(amount, n, id));
            refundNo.set(id, n);
            refundedBy.set(id, (refundedBy.get(id) ?? 0n) + amt(amount));
          } else {
            // Mostly the true remainder; one in four a wrong figure that must be refused.
            const held = heldBy.get(id) ?? amt(amount);
            const refunded = refundedBy.get(id) ?? 0n;
            const left = next(4) === 0 ? amt(amount) : held - refunded;
            await ledger.post(release(formatAmount(left), next(10_000), id, formatAmount(held), formatAmount(refunded)));
          }
          posted[kind]! += 1;
        } catch {
          // A refused post moves nothing; the checks below prove it.
          refused[kind]! += 1;
        }
        expect(ledger.totalsByAsset()[ASSET]).toBe('0');
        expect(ledger.reconcile()).toEqual({ ok: true });
        let total = 0n;
        for (const account of [
          userAvailable(BUYER, ASSET),
          userAvailable(SELLER, ASSET),
          houseFees('market', ASSET),
          ...ids.map((p) => marketPurchaseEscrowAccount(BUYER, ASSET, p)),
        ]) {
          const amount = (await ledger.balance(account)).amount;
          expect(amount >= 0n).toBe(true);
          total += amount;
        }
        // Everything the buyer deposited is in exactly one of these accounts.
        expect(formatAmount(total)).toBe('1000');
      }
    }
    // The sequences really exercise every recipe, both posting and refused.
    for (const kind of [0, 1, 2]) {
      expect(posted[kind]).toBeGreaterThan(0);
      expect(refused[kind]).toBeGreaterThan(0);
    }
  });
});
