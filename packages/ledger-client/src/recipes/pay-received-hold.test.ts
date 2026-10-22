import { describe, expect, it } from 'vitest';
import { userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { PayReceivedPartialError, payReceivedHoldAccount } from './pay-received-hold.js';

const RECIPIENT = '11111111-1111-4111-8111-111111111111';
const PAYER = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';

async function bal(ledger: MemoryLedger, account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

async function funded(amount = '1000'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: RECIPIENT, assetId: ASSET, amount: amt(amount), rail: 'crypto-native', railRef: 'tx-1' }));
  return ledger;
}

const hold = (amount = '300', holdId = 'h1') => recipes.payReceivedHold({ holdId, userId: RECIPIENT, assetId: ASSET, amount: amt(amount) });
const release = (amount = '300', holdId = 'h1') =>
  recipes.payReceivedRelease({ holdId, userId: RECIPIENT, assetId: ASSET, amount: amt(amount), heldAmount: amt(amount) });
const giveBack = (amount = '300', holdId = 'h1') =>
  recipes.payReceivedReturn({
    holdId,
    userId: RECIPIENT,
    payerUserId: PAYER,
    assetId: ASSET,
    amount: amt(amount),
    heldAmount: amt(amount),
  });

describe('holds on received funds (RH-1 to RH-4)', () => {
  it('hold moves recipient available into the per-hold pot under pay.recv.hold:<holdId>', async () => {
    const ledger = await funded();
    const post = hold();
    expect(post.idempotencyKey).toBe('pay.recv.hold:h1');
    expect(payReceivedHoldAccount(RECIPIENT, ASSET, 'h1').purpose).toBe('pay:recv:h1');
    await ledger.post(post);
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('700');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h1'))).toBe('300');
  });

  it('a retried hold posts once', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    await ledger.post(hold());
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('700');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h1'))).toBe('300');
  });

  it('refuses a hold larger than the recipient available balance and moves nothing', async () => {
    const ledger = await funded('100');
    await expect(ledger.post(hold('300'))).rejects.toThrow();
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('100');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h1'))).toBe('0');
  });

  it('release returns the held funds to the recipient once under pay.recv.release:<holdId>', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    const post = release();
    expect(post.idempotencyKey).toBe('pay.recv.release:h1');
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('1000');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h1'))).toBe('0');
  });

  it('return sends the held funds to the payer once under pay.recv.return:<holdId>', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    const post = giveBack();
    expect(post.idempotencyKey).toBe('pay.recv.return:h1');
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('700');
    expect(await bal(ledger, userAvailable(PAYER, ASSET))).toBe('300');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h1'))).toBe('0');
  });

  it('one outcome per hold: release then return is refused, and return then release is refused', async () => {
    const a = await funded();
    await a.post(hold());
    await a.post(release());
    await expect(a.post(giveBack())).rejects.toThrow();
    expect(await bal(a, userAvailable(PAYER, ASSET))).toBe('0');

    const b = await funded();
    await b.post(hold());
    await b.post(giveBack());
    await expect(b.post(release())).rejects.toThrow();
    expect(await bal(b, userAvailable(RECIPIENT, ASSET))).toBe('700');
  });

  it('a release cannot draw on another hold of the same recipient', async () => {
    const ledger = await funded();
    await ledger.post(hold('100', 'h1'));
    await ledger.post(hold('400', 'h2'));
    await expect(ledger.post(release('300', 'h1'))).rejects.toThrow();
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h1'))).toBe('100');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h2'))).toBe('400');
  });

  it('refuses blank ids, non-positive amounts and a return to the recipient', () => {
    expect(() => recipes.payReceivedHold({ holdId: ' ', userId: RECIPIENT, assetId: ASSET, amount: amt('1') })).toThrow(InvalidEntryError);
    expect(() => recipes.payReceivedHold({ holdId: 'h1', userId: '', assetId: ASSET, amount: amt('1') })).toThrow(InvalidEntryError);
    expect(() =>
      recipes.payReceivedRelease({ holdId: 'h1', userId: RECIPIENT, assetId: '', amount: amt('1'), heldAmount: amt('1') }),
    ).toThrow(InvalidEntryError);
    expect(() => recipes.payReceivedHold({ holdId: 'h1', userId: RECIPIENT, assetId: ASSET, amount: 0n })).toThrow(InvalidEntryError);
    expect(() =>
      recipes.payReceivedRelease({ holdId: 'h1', userId: RECIPIENT, assetId: ASSET, amount: -1n, heldAmount: amt('1') }),
    ).toThrow(InvalidEntryError);
    expect(() =>
      recipes.payReceivedReturn({
        holdId: 'h1',
        userId: RECIPIENT,
        payerUserId: '',
        assetId: ASSET,
        amount: amt('1'),
        heldAmount: amt('1'),
      }),
    ).toThrow(InvalidEntryError);
    expect(() =>
      recipes.payReceivedReturn({
        holdId: 'h1',
        userId: RECIPIENT,
        payerUserId: RECIPIENT,
        assetId: ASSET,
        amount: amt('1'),
        heldAmount: amt('1'),
      }),
    ).toThrow(InvalidEntryError);
  });

  it('refuses a partial release with a typed error and moves nothing (RH-2)', async () => {
    const ledger = await funded();
    await ledger.post(hold('300'));
    expect(() =>
      recipes.payReceivedRelease({ holdId: 'h1', userId: RECIPIENT, assetId: ASSET, amount: amt('100'), heldAmount: amt('300') }),
    ).toThrow(PayReceivedPartialError);
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h1'))).toBe('300');
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('700');
  });

  it('refuses a partial return, and a partial release followed by a return of the rest (RH-2)', async () => {
    const ledger = await funded();
    await ledger.post(hold('300'));
    expect(() =>
      recipes.payReceivedReturn({
        holdId: 'h1',
        userId: RECIPIENT,
        payerUserId: PAYER,
        assetId: ASSET,
        amount: amt('200'),
        heldAmount: amt('300'),
      }),
    ).toThrow(PayReceivedPartialError);
    expect(() =>
      recipes.payReceivedRelease({ holdId: 'h1', userId: RECIPIENT, assetId: ASSET, amount: amt('100'), heldAmount: amt('300') }),
    ).toThrow(PayReceivedPartialError);
    expect(() =>
      recipes.payReceivedRelease({ holdId: 'h1', userId: RECIPIENT, assetId: ASSET, amount: amt('300'), heldAmount: 0n }),
    ).toThrow(InvalidEntryError);
    expect(await bal(ledger, userAvailable(PAYER, ASSET))).toBe('0');
    expect(await bal(ledger, payReceivedHoldAccount(RECIPIENT, ASSET, 'h1'))).toBe('300');
  });
});
