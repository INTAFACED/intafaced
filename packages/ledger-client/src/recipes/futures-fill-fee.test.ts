import { describe, expect, it } from 'vitest';
import {
  futuresLossSink,
  futuresOrderMarginAccount,
  houseFees,
  positionCollateralAccount,
  subAccountAvailable,
  subAccountFuturesOrderMargin,
  subAccountPositionCollateral,
  userAvailable,
} from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import type { AccountRef } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';

/**
 * A futures fill's trading fee (docs/adr/2026-10-20-futures-matched-traders.md: trading fees go to house fees through
 * a fee recipe, never into the clearing pot). An opening fill pays it from the order's hold in the fill posting; a
 * reducing fill pays it from the position's pot in the release posting. Neither recipe chooses a rate.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const SUB = '33333333-3333-4333-8333-333333333333';
const ASSET = 'USDT';

async function bal(ledger: MemoryLedger, account: AccountRef): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

async function funded(amount = '1000'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: USER, assetId: ASSET, amount: amt(amount), rail: 'crypto-native', railRef: 'tx-1' }));
  return ledger;
}

const apply = {
  orderId: 'o1',
  userId: USER,
  assetId: ASSET,
  positionId: 'pos1',
  fillId: 'm1:7:pos1',
  amount: amt('250'),
};

describe('futures fill fee: an opening fill pays from the order hold', () => {
  it('moves margin, returns the unused hold and pays the fee in one posting, once', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') }));
    const post = recipes.futuresOrderMarginApply({ ...apply, releaseAmount: amt('40'), fee: amt('10') });
    expect(post.idempotencyKey).toBe('futures.fill:m1:7:pos1');
    expect(post.meta).toMatchObject({ fee: amt('10').toString() });
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('0');
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1'))).toBe('250');
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('740');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('10');
  });

  it('a fee the hold cannot cover refuses the whole fill and moves nothing', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('255') }));
    await expect(ledger.post(recipes.futuresOrderMarginApply({ ...apply, fee: amt('10') }))).rejects.toThrow();
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('255');
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1'))).toBe('0');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('0');
  });

  it('a zero fee posts exactly what the recipe posted before fees', () => {
    const without = recipes.futuresOrderMarginApply({ ...apply, releaseAmount: amt('5') });
    const zero = recipes.futuresOrderMarginApply({ ...apply, releaseAmount: amt('5'), fee: 0n });
    expect(zero).toEqual(without);
    expect(without.entries).toHaveLength(4);
  });

  it('a sub-account order pays its fee from the sub-account hold, never the parent', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(recipes.deposit({ userId: USER, assetId: ASSET, amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-1' }));
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: ASSET,
        amount: amt('500'),
        rail: 'crypto-native',
        railRef: 'tx-sub',
        subAccountId: SUB,
        confirmed: true,
      }),
    );
    await ledger.post(
      recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300'), subAccountId: SUB }),
    );
    await ledger.post(recipes.futuresOrderMarginApply({ ...apply, subAccountId: SUB, releaseAmount: amt('40'), fee: amt('10') }));
    expect(await bal(ledger, subAccountFuturesOrderMargin(SUB, ASSET, 'o1'))).toBe('0');
    expect(await bal(ledger, subAccountPositionCollateral(SUB, ASSET, 'pos1'))).toBe('250');
    expect(await bal(ledger, subAccountAvailable(SUB, ASSET))).toBe('240');
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('1000');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('10');
  });

  it('refuses a negative fee before any key is built', () => {
    expect(() => recipes.futuresOrderMarginApply({ ...apply, fee: -1n })).toThrow(InvalidEntryError);
  });
});

describe('futures fill fee: a reducing fill pays from the position pot', () => {
  async function withPosition(margin = '100'): Promise<MemoryLedger> {
    const ledger = await funded();
    await ledger.post(recipes.futuresMarginLock({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: amt(margin) }));
    return ledger;
  }

  it('releases margin and pays the fee in one posting, once', async () => {
    const ledger = await withPosition();
    const post = recipes.futuresMarginRelease({
      positionId: 'pos1',
      userId: USER,
      assetId: ASSET,
      amount: amt('60'),
      fee: amt('5'),
      sequence: 3,
    });
    expect(post.meta).toMatchObject({ fee: amt('5').toString() });
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1'))).toBe('35');
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('960');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('5');
  });

  it('a close whose loss took the rest of the margin still pays its fee from what the pot holds', async () => {
    const ledger = await withPosition();
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: 'pos1',
        userId: USER,
        assetId: ASSET,
        fromMargin: amt('97'),
        fromInsurance: 0n,
        lossId: 'l1',
      }),
    );
    await ledger.post(recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: 0n, fee: amt('3') }));
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1'))).toBe('0');
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('900');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('3');
  });

  it('a fee beyond the pot refuses the whole release and moves nothing', async () => {
    const ledger = await withPosition();
    await expect(
      ledger.post(recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: amt('98'), fee: amt('3') })),
    ).rejects.toThrow();
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1'))).toBe('100');
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('900');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('0');
  });

  it('without a fee the release is unchanged: two entries, and a zero amount still refuses', () => {
    const plain = recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: amt('60') });
    expect(plain.entries).toHaveLength(2);
    expect(recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: amt('60'), fee: 0n })).toEqual(plain);
    expect(() => recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: 0n })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: -1n, fee: amt('1') })).toThrow(
      InvalidEntryError,
    );
    expect(() => recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: amt('1'), fee: -1n })).toThrow(
      InvalidEntryError,
    );
  });
});

describe('futures fill fee invariant', () => {
  it('open with a fee, lose part, close with a fee: every unit is still on the books, and fees are only fees', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') }));
    await ledger.post(recipes.futuresOrderMarginApply({ ...apply, releaseAmount: amt('40'), fee: amt('10') }));
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: 'pos1',
        userId: USER,
        assetId: ASSET,
        fromMargin: amt('20'),
        fromInsurance: 0n,
        lossId: 'l1',
      }),
    );
    await ledger.post(
      recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: amt('225'), fee: amt('5') }),
    );

    const available = amt(await bal(ledger, userAvailable(USER, ASSET)));
    const hold = amt(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1')));
    const pot = amt(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1')));
    const fees = amt(await bal(ledger, houseFees('trade', ASSET)));
    const sink = amt(await bal(ledger, futuresLossSink(ASSET)));
    expect(formatAmount(available + hold + pot + fees + sink)).toBe('1000');
    expect(formatAmount(fees)).toBe('15');
    expect(formatAmount(sink)).toBe('20');
    expect(formatAmount(available)).toBe('965');
    expect(hold + pot).toBe(0n);
  });
});
