import { describe, expect, it } from 'vitest';
import { userAvailable } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InsufficientFundsError, InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { PayUnclaimedPartialError, payUnclaimedAccount } from './pay-unclaimed.js';

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const ASSET = 'USDT';

async function bal(ledger: MemoryLedger, account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

async function funded(amount = '40'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: SENDER, assetId: ASSET, amount: amt(amount), rail: 'crypto-native', railRef: 'tx-1' }));
  return ledger;
}

const hold = (amount = '15', sendId = 's1') =>
  recipes.payUnclaimedHold({ sendId, senderUserId: SENDER, assetId: ASSET, amount: amt(amount) });
const claim = (amount = '15', sendId = 's1') =>
  recipes.payUnclaimedClaim({
    sendId,
    senderUserId: SENDER,
    recipientUserId: RECIPIENT,
    assetId: ASSET,
    amount: amt(amount),
    heldAmount: amt(amount),
  });
const giveBack = (amount = '15', sendId = 's1') =>
  recipes.payUnclaimedReturn({ sendId, senderUserId: SENDER, assetId: ASSET, amount: amt(amount), heldAmount: amt(amount) });

describe('a send to someone who is not a member yet (J-pay-04)', () => {
  it('the send sets the amount aside in the sender pot under pay.unclaimed.hold:<sendId>', async () => {
    const ledger = await funded();
    const post = hold();
    expect(post.idempotencyKey).toBe('pay.unclaimed.hold:s1');
    expect(post.reason).toBe('pay.unclaimed.held');
    expect(payUnclaimedAccount(SENDER, ASSET, 's1')).toMatchObject({ ownerId: SENDER, kind: 'hold', purpose: 'pay:unclaimed:s1' });
    await ledger.post(post);
    expect(await bal(ledger, userAvailable(SENDER, ASSET))).toBe('25');
    expect(await bal(ledger, payUnclaimedAccount(SENDER, ASSET, 's1'))).toBe('15');
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('0');
  });

  it('a retried send sets it aside once', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    await ledger.post(hold());
    expect(await bal(ledger, userAvailable(SENDER, ASSET))).toBe('25');
    expect(await bal(ledger, payUnclaimedAccount(SENDER, ASSET, 's1'))).toBe('15');
  });

  it('refuses a send larger than the sender available balance and moves nothing', async () => {
    const ledger = await funded('10');
    await expect(ledger.post(hold('15'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(ledger, userAvailable(SENDER, ASSET))).toBe('10');
    expect(await bal(ledger, payUnclaimedAccount(SENDER, ASSET, 's1'))).toBe('0');
  });

  it('the claim posts once to the recipient under pay.unclaimed.claim:<sendId>', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    const post = claim();
    expect(post.idempotencyKey).toBe('pay.unclaimed.claim:s1');
    expect(post.reason).toBe('pay.unclaimed.claimed');
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('15');
    expect(await bal(ledger, userAvailable(SENDER, ASSET))).toBe('25');
    expect(await bal(ledger, payUnclaimedAccount(SENDER, ASSET, 's1'))).toBe('0');
  });

  it('a cancel or an expiry returns it once to the sender under pay.unclaimed.return:<sendId>', async () => {
    const ledger = await funded();
    await ledger.post(hold());
    const post = giveBack();
    expect(post.idempotencyKey).toBe('pay.unclaimed.return:s1');
    expect(post.reason).toBe('pay.unclaimed.returned');
    await ledger.post(post);
    await ledger.post(post);
    expect(await bal(ledger, userAvailable(SENDER, ASSET))).toBe('40');
    expect(await bal(ledger, payUnclaimedAccount(SENDER, ASSET, 's1'))).toBe('0');
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('0');
  });

  it('claim and return of one send: exactly one wins, whichever comes first', async () => {
    const a = await funded();
    await a.post(hold());
    await a.post(claim());
    await expect(a.post(giveBack())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(a, userAvailable(SENDER, ASSET))).toBe('25');
    expect(await bal(a, userAvailable(RECIPIENT, ASSET))).toBe('15');

    const b = await funded();
    await b.post(hold());
    await b.post(giveBack());
    await expect(b.post(claim())).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(b, userAvailable(SENDER, ASSET))).toBe('40');
    expect(await bal(b, userAvailable(RECIPIENT, ASSET))).toBe('0');
  });

  it('a claim or a return cannot draw on another send of the same sender', async () => {
    const ledger = await funded();
    await ledger.post(hold('5', 's1'));
    await ledger.post(hold('15', 's2'));
    await expect(ledger.post(claim('15', 's1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(ledger.post(giveBack('15', 's1'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(ledger, payUnclaimedAccount(SENDER, ASSET, 's1'))).toBe('5');
    expect(await bal(ledger, payUnclaimedAccount(SENDER, ASSET, 's2'))).toBe('15');
    expect(await bal(ledger, userAvailable(RECIPIENT, ASSET))).toBe('0');
  });

  it('refuses a partial claim or return with a typed error before any post', async () => {
    const ledger = await funded();
    await ledger.post(hold('15'));
    const base = { sendId: 's1', senderUserId: SENDER, assetId: ASSET, heldAmount: amt('15') };
    expect(() => recipes.payUnclaimedClaim({ ...base, recipientUserId: RECIPIENT, amount: amt('5') })).toThrow(PayUnclaimedPartialError);
    expect(() => recipes.payUnclaimedReturn({ ...base, amount: amt('10') })).toThrow(PayUnclaimedPartialError);
    expect(() => recipes.payUnclaimedReturn({ ...base, amount: amt('15'), heldAmount: 0n })).toThrow(InvalidEntryError);
    expect(await bal(ledger, payUnclaimedAccount(SENDER, ASSET, 's1'))).toBe('15');
    expect(await bal(ledger, userAvailable(SENDER, ASSET))).toBe('25');
  });

  it('refuses blank ids, non-positive amounts and a claim by the sender', () => {
    const one = amt('1');
    expect(() => recipes.payUnclaimedHold({ sendId: ' ', senderUserId: SENDER, assetId: ASSET, amount: one })).toThrow(InvalidEntryError);
    expect(() => recipes.payUnclaimedHold({ sendId: 's1', senderUserId: '', assetId: ASSET, amount: one })).toThrow(InvalidEntryError);
    expect(() => recipes.payUnclaimedHold({ sendId: 's1', senderUserId: SENDER, assetId: '', amount: one })).toThrow(InvalidEntryError);
    expect(() => recipes.payUnclaimedHold({ sendId: 's1', senderUserId: SENDER, assetId: ASSET, amount: 0n })).toThrow(InvalidEntryError);
    expect(() => recipes.payUnclaimedReturn({ sendId: 's1', senderUserId: SENDER, assetId: ASSET, amount: -1n, heldAmount: one })).toThrow(
      InvalidEntryError,
    );
    expect(() =>
      recipes.payUnclaimedClaim({ sendId: 's1', senderUserId: SENDER, recipientUserId: ' ', assetId: ASSET, amount: one, heldAmount: one }),
    ).toThrow(InvalidEntryError);
    expect(() =>
      recipes.payUnclaimedClaim({
        sendId: 's1',
        senderUserId: SENDER,
        recipientUserId: SENDER,
        assetId: ASSET,
        amount: one,
        heldAmount: one,
      }),
    ).toThrow(InvalidEntryError);
    expect(() => payUnclaimedAccount(SENDER, ASSET, ' ')).toThrow(InvalidEntryError);
  });

  it('invariant: random sends, claims and returns never create, lose or double-move money', async () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const seen = { hold: [0, 0], claim: [0, 0], return: [0, 0] };
    for (let run = 0; run < 40; run += 1) {
      const ledger = await funded('100');
      const held = new Map<string, string>();
      for (let step = 0; step < 25; step += 1) {
        const id = `s${rand(6)}`;
        const action = (['hold', 'claim', 'return'] as const)[rand(3)]!;
        const amount = held.get(id) ?? String(1 + rand(60));
        const post = action === 'hold' ? hold(amount, id) : action === 'claim' ? claim(amount, id) : giveBack(amount, id);
        try {
          await ledger.post(post);
          seen[action][0] += 1;
          if (action === 'hold') held.set(id, amount);
        } catch (err) {
          expect(err).toBeInstanceOf(InsufficientFundsError);
          seen[action][1] += 1;
        }
        let pots = 0n;
        for (let i = 0; i < 6; i += 1) {
          const b = (await ledger.balance(payUnclaimedAccount(SENDER, ASSET, `s${i}`))).amount;
          expect(b >= 0n).toBe(true);
          pots += b;
        }
        const sender = (await ledger.balance(userAvailable(SENDER, ASSET))).amount;
        const recipient = (await ledger.balance(userAvailable(RECIPIENT, ASSET))).amount;
        expect(sender >= 0n && recipient >= 0n).toBe(true);
        expect(formatAmount(sender + recipient + pots)).toBe('100');
        expect(ledger.reconcile()).toEqual({ ok: true });
      }
    }
    for (const [action, [posted, refused]] of Object.entries(seen)) {
      expect(posted, `${action} posted at least once`).toBeGreaterThan(0);
      expect(refused, `${action} refused at least once`).toBeGreaterThan(0);
    }
  });
});
