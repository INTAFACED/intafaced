import { describe, expect, it } from 'vitest';
import { userAvailable, userHold } from '../accounts.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt, type Amount } from '../money.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';
import { BankTransferReversalError, bankTransferReversalKey, type BankTransferReversalInput } from './bank-transfer-reversal.js';

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

/** What svc-bank reads from its stored transfer row for t1. */
const stored = (overrides: Partial<BankTransferReversalInput> = {}): BankTransferReversalInput => ({
  originalKeySpace: 'p2p',
  transferId: 't1',
  occurrence: 0,
  consentId: 'consent-1',
  originalFrom: from,
  originalTo: to,
  originalAmount: amt('100'),
  amount: amt('100'),
  ...overrides,
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe('consented reversal of a posted internal send', () => {
  it('moves the whole amount from the recipient back to the sender as a new posting', async () => {
    const ledger = await sent();
    const post = recipes.bankTransferReversal(stored());
    expect(post.idempotencyKey).toBe('bank.transfer.reverse:p2p:t1:0');
    expect(post.meta).toMatchObject({ keySpace: 'p2p', transferId: 't1', occurrence: 0, consentId: 'consent-1' });
    await ledger.post(post);
    expect(await bal(ledger, from)).toBe('1000');
    expect(await bal(ledger, to)).toBe('0');
    expect(ledger.journal()).toHaveLength(3);
  });

  it('one reversal per original send: a retried or second consent resolves to the first', async () => {
    const ledger = await sent();
    await ledger.post(recipes.bankTransferReversal(stored()));
    await ledger.post(recipes.bankTransferReversal(stored()));
    await ledger.post(recipes.bankTransferReversal(stored({ consentId: 'consent-2' })));
    expect(await bal(ledger, from)).toBe('1000');
    expect(ledger.journal()).toHaveLength(3);
  });

  it('keys on the original key space, so the same id in another space is another send', () => {
    expect(bankTransferReversalKey('own', 't1', 0)).not.toBe(bankTransferReversalKey('p2p', 't1', 0));
    expect(bankTransferReversalKey('sched', 't1', 3)).toBe('bank.transfer.reverse:sched:t1:3');
    expect(() => bankTransferReversalKey('rail' as never, 't1', 0)).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ originalKeySpace: 'nope' as never }))).toThrow(InvalidEntryError);
  });

  it('refuses when the recipient no longer holds the funds and moves nothing', async () => {
    const ledger = await sent();
    await ledger.post(
      recipes.bankTransfer({ transferId: 't9', occurrence: 0, from: to, to: from, amount: amt('60'), kind: 'manual', keySpace: 'p2p' }),
    );
    await expect(ledger.post(recipes.bankTransferReversal(stored()))).rejects.toThrow();
    expect(await bal(ledger, from)).toBe('960');
    expect(await bal(ledger, to)).toBe('40');
  });

  it('refuses a partial or over-amount reversal with bank.transfer.partial_reversal', () => {
    expect(code(() => recipes.bankTransferReversal(stored({ amount: amt('40') })))).toBe('bank.transfer.partial_reversal');
    expect(code(() => recipes.bankTransferReversal(stored({ amount: amt('150') })))).toBe('bank.transfer.partial_reversal');
    expect(() => recipes.bankTransferReversal(stored({ amount: amt('40') }))).toThrow(BankTransferReversalError);
  });

  it('refuses a zero original amount, a negative or zero amount and a non-bigint amount', () => {
    expect(() => recipes.bankTransferReversal(stored({ originalAmount: 0n }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ amount: -1n, originalAmount: -1n }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ amount: 0n }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ amount: 100 as unknown as Amount }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ originalAmount: '100' as unknown as Amount }))).toThrow(InvalidEntryError);
  });

  it('refuses a blank consent with bank.transfer.consent_missing', () => {
    expect(code(() => recipes.bankTransferReversal(stored({ consentId: ' ' })))).toBe('bank.transfer.consent_missing');
    expect(code(() => recipes.bankTransferReversal(stored({ consentId: undefined as unknown as string })))).toBe(
      'bank.transfer.consent_missing',
    );
  });

  it('refuses bad ids and malformed accounts', () => {
    expect(() => recipes.bankTransferReversal(stored({ transferId: '' }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ occurrence: -1 }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ occurrence: 1.5 }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ originalTo: from }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ originalTo: userAvailable(RECIPIENT, 'BTC') }))).toThrow(InvalidEntryError);
    expect(() => recipes.bankTransferReversal(stored({ originalFrom: userHold(SENDER, A, 'x') }))).toThrow(InvalidEntryError);
  });
});
