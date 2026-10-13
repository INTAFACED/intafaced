import { describe, expect, it } from 'vitest';
import { orderHoldAccount, userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { orderHoldAmend, type OrderHoldAmendInput } from './order-hold-amend.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ORDER = 'o-1';
const ASSET = 'USDT';

const real = (): OrderHoldAmendInput => ({
  orderId: ORDER,
  userId: USER,
  assetId: ASSET,
  amount: amt('50'),
  sequence: 1,
});

function expectRefuse(input: OrderHoldAmendInput): void {
  let posted: ReturnType<typeof orderHoldAmend> | undefined;
  try {
    posted = orderHoldAmend(input);
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidEntryError);
    expect((err as Error).message).not.toContain('order.hold.amend:');
    expect(posted).toBeUndefined();
    return;
  }
  throw new Error(`orderHoldAmend returned a post ${posted.idempotencyKey}`);
}

describe('orderHoldAmend', () => {
  it('refuses NaN and does not produce order.hold.amend:<orderId>:NaN', () => {
    expectRefuse({ ...real(), sequence: NaN });
    expect(() => orderHoldAmend({ ...real(), sequence: NaN })).toThrow(InvalidEntryError);
  });

  it('refuses undefined sequence', () => {
    expectRefuse({ ...real(), sequence: undefined as unknown as number });
  });

  it('refuses Infinity sequence', () => {
    expectRefuse({ ...real(), sequence: Infinity });
  });

  it('refuses a non-integer sequence such as 1.5', () => {
    expectRefuse({ ...real(), sequence: 1.5 });
  });

  it('refuses a blank orderId before any key or post', () => {
    expectRefuse({ ...real(), orderId: '' });
  });

  it('refuses a blank userId before any key or post', () => {
    expectRefuse({ ...real(), userId: '' });
  });

  it('refuses a blank assetId before any key or post', () => {
    expectRefuse({ ...real(), assetId: '' });
  });

  it('refuses whitespace-only and missing ids', () => {
    expectRefuse({ ...real(), orderId: '   ' });
    expectRefuse({ ...real(), userId: '\t' });
    expectRefuse({ ...real(), assetId: '\n' });
    expectRefuse({ ...real(), orderId: undefined as unknown as string });
    expectRefuse({ ...real(), userId: undefined as unknown as string });
    expectRefuse({ ...real(), assetId: undefined as unknown as string });
  });

  it('refuses a non-positive hold amount', () => {
    expect(() => orderHoldAmend({ ...real(), amount: 0n })).toThrow(InvalidEntryError);
    expect(() => orderHoldAmend({ ...real(), amount: -1n })).toThrow(/order amend hold amount must be positive/);
  });

  it('posts a positive amount with an integer sequence and real ids', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: ASSET,
        amount: amt('200'),
        rail: 'test',
        railRef: 'amend-real',
      }),
    );
    const journalBefore = ledger.journal().length;
    const tx = await ledger.post(orderHoldAmend(real()));
    expect(tx.idempotencyKey).toBe('order.hold.amend:o-1:1');
    expect(tx.reason).toBe('order.hold.amend');
    expect(ledger.journal().length).toBe(journalBefore + 1);
    expect(formatAmount((await ledger.balance(userAvailable(USER, ASSET))).amount)).toBe('150');
    expect(formatAmount((await ledger.balance(orderHoldAccount(USER, ASSET, ORDER))).amount)).toBe('50');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a refused NaN amend leaves the book unposted', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({
        userId: USER,
        assetId: ASSET,
        amount: amt('200'),
        rail: 'test',
        railRef: 'amend-nan',
      }),
    );
    const journalBefore = ledger.journal().length;
    expect(() => orderHoldAmend({ ...real(), sequence: NaN })).toThrow(InvalidEntryError);
    expect(ledger.journal()).toHaveLength(journalBefore);
    expect(ledger.journal().some((row) => row.idempotencyKey.includes(':NaN'))).toBe(false);
  });
});
