import { describe, expect, it } from 'vitest';
import { userAvailable, userHold } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { bankTransferReversalKey } from './bank-transfer-reversal.js';

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const A = 'USDT';
const from = userAvailable(SENDER, A);
const to = userAvailable(RECIPIENT, A);

async function bal(ledger: MemoryLedger, account: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(account)).amount);
}

async function sent(amount = '100'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(recipes.deposit({ userId: SENDER, assetId: A, amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-1' }));
  await ledger.post(
    recipes.bankTransfer({ transferId: 't1', occurrence: 0, from, to, amount: amt(amount), kind: 'manual', keySpace: 'p2p' }),
  );
  return ledger;
}

const reversal = (amount = '100', consentId = 'consent-1') =>
  recipes.bankTransferReversal({ transferId: 't1', occurrence: 0, consentId, originalFrom: from, originalTo: to, amount: amt(amount) });

describe('consented reversal of a posted internal send', () => {
  it('moves the value from the recipient back to the sender as a new posting', async () => {
    const ledger = await sent();
    const post = reversal();
    expect(post.idempotencyKey).toBe('bank.transfer.reverse:t1:0');
    expect(post.meta).toMatchObject({ transferId: 't1', occurrence: 0, consentId: 'consent-1' });
    await ledger.post(post);
    expect(await bal(ledger, from)).toBe('1000');
    expect(await bal(ledger, to)).toBe('0');
    expect(ledger.journal()).toHaveLength(3);
  });

  it('one reversal per original firing: a retried or second consent posts once', async () => {
    const ledger = await sent();
    await ledger.post(reversal());
    await ledger.post(reversal());
    // A second consent for the same firing is the same request: the key returns the first reversal.
    await ledger.post(reversal('100', 'consent-2'));
    expect(await bal(ledger, from)).toBe('1000');
    expect(ledger.journal()).toHaveLength(3);
  });

  it('refuses when the recipient no longer holds the funds and moves nothing', async () => {
    const ledger = await sent();
    await expect(ledger.post(reversal('150'))).rejects.toThrow();
    expect(await bal(ledger, from)).toBe('900');
    expect(await bal(ledger, to)).toBe('100');
  });

  it('refuses without consent, ids, a positive amount, or with malformed accounts', () => {
    const base = { transferId: 't1', occurrence: 0, consentId: 'c', originalFrom: from, originalTo: to, amount: amt('1') };
    expect(() => recipes.bankTransferReversal({ ...base, consentId: ' ' })).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal({ ...base, transferId: '' })).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal({ ...base, occurrence: -1 })).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal({ ...base, occurrence: 1.5 })).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal({ ...base, amount: 0n })).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal({ ...base, originalTo: from })).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal({ ...base, originalTo: userAvailable(RECIPIENT, 'BTC') })).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal({ ...base, originalFrom: userHold(SENDER, A, 'x') })).toThrow(InvalidEntryError);
    expect(() => bankTransferReversalKey('', 0)).toThrow(InvalidEntryError);
  });
});
