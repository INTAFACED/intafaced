import { describe, expect, it } from 'vitest';
import { houseFees, merchantClearing, moduleAccount, railBoundary, userAvailable } from '../accounts.js';
import { accountKey } from '../client.js';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { InvalidEntryError, type EntryInput, type PostRequest } from '../types.js';
import { OPERATOR_REVERSAL_MODULE, OPERATOR_REVERSAL_REASON, operatorReverse, type OperatorReverseInput } from './operator-reverse.js';

// The same cases as `crates/svc-ledger/src/reversal.rs`'s tests: the Rust ledger builds the post, this is its twin.
const ORIGINAL = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';

/** A TEST original over two assets, our own accounts only: a rail boundary to a fee pot in USDT, and to a module pot in BTC. */
const LEGS: readonly EntryInput[] = [
  { account: railBoundary('local-test', 'USDT'), direction: 'credit', amount: amt('10.5') },
  { account: houseFees('trade', 'USDT'), direction: 'debit', amount: amt('10.5') },
  { account: railBoundary('local-test', 'BTC'), direction: 'credit', amount: amt('0.000000000000000001') },
  { account: moduleAccount('bank', 'loan-reserve', 'BTC'), direction: 'debit', amount: amt('0.000000000000000001') },
];

const input = (over: Partial<OperatorReverseInput> = {}): OperatorReverseInput => ({
  originalTxId: ORIGINAL,
  entries: LEGS,
  ordinal: '1',
  why: ' LOCAL TEST posted to the wrong account ',
  caseRef: ' case-7 ',
  ...over,
});

/** Signed movement per account and per asset, as the ledger counts it (a debit adds, a credit subtracts). */
function net(posts: readonly { entries: readonly EntryInput[] }[], by: (e: EntryInput) => string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const p of posts) {
    for (const e of p.entries) {
      const k = by(e);
      out.set(k, (out.get(k) ?? 0n) + (e.direction === 'debit' ? e.amount : -e.amount));
    }
  }
  return out;
}

describe('operatorReverse', () => {
  it('keys the reversal by the original id lower-cased and the stored ordinal, and links it in meta', () => {
    const post = operatorReverse(input({ ordinal: '12' }));
    expect(post.idempotencyKey).toBe('ops:reversal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:12');
    expect(post.module).toBe(OPERATOR_REVERSAL_MODULE);
    expect(post.module).toBe('ops');
    expect(post.reason).toBe(OPERATOR_REVERSAL_REASON);
    expect(post.reason).toBe('operator.reversal');
    expect(post.meta).toEqual({
      reverses: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      caseRef: 'case-7',
      why: 'LOCAL TEST posted to the wrong account',
    });
  });

  it('flips each leg, same account, same amount, in the same order', () => {
    const post = operatorReverse(input());
    expect(post.entries).toEqual([
      { account: LEGS[0]!.account, direction: 'debit', amount: amt('10.5') },
      { account: LEGS[1]!.account, direction: 'credit', amount: amt('10.5') },
      { account: LEGS[2]!.account, direction: 'debit', amount: amt('0.000000000000000001') },
      { account: LEGS[3]!.account, direction: 'credit', amount: amt('0.000000000000000001') },
    ]);
  });

  it('nets to zero per asset, and per account, with the original', () => {
    const pair = [{ entries: LEGS }, operatorReverse(input())];
    for (const sum of net(pair, (e) => e.account.assetId).values()) expect(sum).toBe(0n);
    for (const sum of net(pair, (e) => accountKey(e.account)).values()) expect(sum).toBe(0n);
    expect([...net(pair, (e) => e.account.assetId).keys()].sort()).toEqual(['BTC', 'USDT']);
  });

  it('refuses an ordinal that is not a whole number from one', () => {
    for (const ordinal of ['0', '-1', '1.5', '01', '', ' 1', '1e3', '12345678901234567890']) {
      expect(() => operatorReverse(input({ ordinal })), ordinal).toThrow(InvalidEntryError);
    }
    // A number where the wire says string, as an untyped caller could send it.
    const numeric: OperatorReverseInput = { ...input(), ...(JSON.parse('{"ordinal":1}') as object) };
    expect(() => operatorReverse(numeric)).toThrow(InvalidEntryError);
    expect(operatorReverse(input({ ordinal: '1234567890123456789' })).idempotencyKey).toMatch(/:1234567890123456789$/);
  });

  it('refuses a blank reason or case reference', () => {
    for (const why of ['', '   ']) expect(() => operatorReverse(input({ why }))).toThrow(/reason the operators approved/);
    for (const caseRef of ['', '\t ']) expect(() => operatorReverse(input({ caseRef }))).toThrow(/case reference/);
  });

  it("refuses an original that moves a customer's balance: a user's account, or a merchant's clearing pot", () => {
    for (const customer of [userAvailable(CUSTOMER, 'USDT'), merchantClearing('merchant-1', 'USDT')]) {
      const entries: EntryInput[] = [
        ...LEGS,
        { account: customer, direction: 'debit', amount: amt('1') },
        { account: railBoundary('local-test', 'USDT'), direction: 'credit', amount: amt('1') },
      ];
      expect(() => operatorReverse(input({ entries })), customer.ownerId).toThrow(InvalidEntryError);
      expect(() => operatorReverse(input({ entries })), customer.ownerId).toThrow(
        "A reversal touches only INTAFACED's own records; the original moves a customer's balance",
      );
    }
  });

  it('refuses an original with no entries, and an original not named by a UUID', () => {
    expect(() => operatorReverse(input({ entries: [] }))).toThrow(/original transaction legs/);
    expect(() => operatorReverse(input({ originalTxId: 'not-a-uuid' }))).toThrow(/by its id/);
  });

  it('on a book, the reversal puts every balance back where it was before the original', async () => {
    const ledger = new MemoryLedger();
    const seed: PostRequest = { idempotencyKey: 'test:operator-reverse:seed', module: 'ledger', reason: 'test.seed', entries: LEGS };
    const original = await ledger.post(seed);
    const back = await ledger.post(operatorReverse({ ...input(), originalTxId: original.id, entries: seed.entries }));
    expect(back.id).not.toBe(original.id);
    for (const e of LEGS) expect(formatAmount((await ledger.balance(e.account)).amount), accountKey(e.account)).toBe('0');
  });
});
