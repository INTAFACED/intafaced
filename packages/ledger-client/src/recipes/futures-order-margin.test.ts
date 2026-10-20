import { describe, expect, it } from 'vitest';
import {
  futuresLossSink,
  futuresOrderMarginAccount,
  positionCollateralAccount,
  subAccountAvailable,
  subAccountFuturesOrderMargin,
  subAccountPositionCollateral,
  userAvailable,
} from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SUB = '33333333-3333-4333-8333-333333333333';
const ASSET = 'USDT';

async function bal(ledger: MemoryLedger, account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

async function funded(amount = '1000'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: USER, assetId: ASSET, amount: amt(amount), rail: 'crypto-native', railRef: 'tx-1' }));
  return ledger;
}

describe('futures order margin recipes', () => {
  it('hold moves available into the order pot and leaves the book balanced', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') }));
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('700');
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('300');
  });

  it('hold is keyed on the order: a retry posts once', async () => {
    const ledger = await funded();
    const hold = recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') });
    expect(hold.idempotencyKey).toBe('futures.order.margin.hold:o1');
    await ledger.post(hold);
    await ledger.post(hold);
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('700');
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('300');
  });

  it('refuses a hold the trader cannot afford and moves nothing', async () => {
    const ledger = await funded('100');
    await expect(
      ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') })),
    ).rejects.toThrow();
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('100');
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('0');
  });

  it('release returns margin and the same sequence posts once', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') }));
    const release = recipes.futuresOrderMarginRelease({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('100'), sequence: 1 });
    await ledger.post(release);
    await ledger.post(release);
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('800');
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('200');
    await ledger.post(recipes.futuresOrderMarginRelease({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('100'), sequence: 2 }));
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('900');
  });

  it('cannot release more than the order holds, even when the same trader has another order held', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('100') }));
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o2', userId: USER, assetId: ASSET, amount: amt('500') }));
    await expect(
      ledger.post(recipes.futuresOrderMarginRelease({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('101') })),
    ).rejects.toThrow();
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('100');
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o2'))).toBe('500');
  });

  it('apply moves the fill margin into the position pot and returns the unused part in one posting', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') }));
    const apply = recipes.futuresOrderMarginApply({
      orderId: 'o1',
      userId: USER,
      assetId: ASSET,
      positionId: 'pos1',
      fillId: 'm1:7:pos1',
      amount: amt('250'),
      releaseAmount: amt('50'),
    });
    expect(apply.idempotencyKey).toBe('futures.fill:m1:7:pos1');
    await ledger.post(apply);
    await ledger.post(apply);
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('0');
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1'))).toBe('250');
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('750');
  });

  it('a partial fill leaves the rest of the hold on the order', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') }));
    await ledger.post(
      recipes.futuresOrderMarginApply({
        orderId: 'o1',
        userId: USER,
        assetId: ASSET,
        positionId: 'pos1',
        fillId: 'm1:1:pos1',
        amount: amt('100'),
      }),
    );
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('200');
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1'))).toBe('100');
  });

  it('apply refuses to take more than the order holds and moves nothing', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('100') }));
    await expect(
      ledger.post(
        recipes.futuresOrderMarginApply({
          orderId: 'o1',
          userId: USER,
          assetId: ASSET,
          positionId: 'pos1',
          fillId: 'm1:1:pos1',
          amount: amt('90'),
          releaseAmount: amt('20'),
        }),
      ),
    ).rejects.toThrow();
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('100');
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, 'pos1'))).toBe('0');
  });

  it('the position pot it fills is the one futuresMarginRelease and futuresRealizeLoss use', async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') }));
    await ledger.post(
      recipes.futuresOrderMarginApply({
        orderId: 'o1',
        userId: USER,
        assetId: ASSET,
        positionId: 'pos1',
        fillId: 'm1:1:pos1',
        amount: amt('300'),
      }),
    );
    await ledger.post(
      recipes.futuresRealizeLoss({
        positionId: 'pos1',
        userId: USER,
        assetId: ASSET,
        fromMargin: amt('120'),
        fromInsurance: 0n,
        lossId: 'l1',
      }),
    );
    await ledger.post(recipes.futuresMarginRelease({ positionId: 'pos1', userId: USER, assetId: ASSET, amount: amt('180') }));
    expect(await bal(ledger, futuresLossSink(ASSET))).toBe('120');
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('880');
  });

  it('a sub-account order uses the sub-account pots and never the parent user', async () => {
    const ledger = new MemoryLedger();
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
      recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('200'), subAccountId: SUB }),
    );
    await ledger.post(
      recipes.futuresOrderMarginApply({
        orderId: 'o1',
        userId: USER,
        assetId: ASSET,
        positionId: 'pos1',
        fillId: 'm1:1:pos1',
        amount: amt('150'),
        releaseAmount: amt('50'),
        subAccountId: SUB,
      }),
    );
    expect(await bal(ledger, subAccountAvailable(SUB, ASSET))).toBe('350');
    expect(await bal(ledger, subAccountFuturesOrderMargin(SUB, ASSET, 'o1'))).toBe('0');
    expect(await bal(ledger, subAccountPositionCollateral(SUB, ASSET, 'pos1'))).toBe('150');
    expect(await bal(ledger, userAvailable(USER, ASSET))).toBe('0');
  });

  it("another trader's order of the same id cannot touch this order's margin", async () => {
    const ledger = await funded();
    await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('300') }));
    await expect(
      ledger.post(recipes.futuresOrderMarginRelease({ orderId: 'o1', userId: OTHER, assetId: ASSET, amount: amt('300') })),
    ).rejects.toThrow();
    expect(await bal(ledger, futuresOrderMarginAccount(USER, ASSET, 'o1'))).toBe('300');
  });

  it('refuses bad input before any key is built', () => {
    const base = { orderId: 'o1', userId: USER, assetId: ASSET, amount: amt('1') };
    expect(() => recipes.futuresOrderMarginHold({ ...base, amount: 0n })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginHold({ ...base, orderId: '  ' })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginHold({ ...base, userId: '' })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginRelease({ ...base, amount: -1n })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginRelease({ ...base, sequence: -1 })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginRelease({ ...base, sequence: 1.5 })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginRelease({ ...base, sequence: NaN })).toThrow(InvalidEntryError);
    const apply = { ...base, positionId: 'pos1', fillId: 'f1' };
    expect(() => recipes.futuresOrderMarginApply({ ...apply, positionId: '' })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginApply({ ...apply, fillId: ' ' })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginApply({ ...apply, amount: 0n })).toThrow(InvalidEntryError);
    expect(() => recipes.futuresOrderMarginApply({ ...apply, releaseAmount: -1n })).toThrow(InvalidEntryError);
  });
});
