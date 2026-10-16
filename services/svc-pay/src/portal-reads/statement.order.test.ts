import type { Sql } from 'postgres';
import { parseAmount, type AccountRef, type Balance, type LedgerTx, type PostedEntry } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import type { PayFail } from './common.js';
import { stableUuid } from './common.js';
import { listMerchantStatement } from './statement.js';

const MERCHANT = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const USER = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
const PAY_DEBIT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5';
const PAY_CREDIT = 'ffffffff-ffff-4fff-8fff-fffffffffff6';
const DEBIT_TX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CREDIT_TX = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const AT = new Date('2026-06-15T12:00:00.000Z');
const RANGE = { merchantId: MERCHANT, limit: 20, from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };

const fail: PayFail = (message, code) => {
  throw new Error(`${code}: ${message}`);
};

function lineIds(): { debit: string; credit: string } {
  for (let n = 0; n < 5000; n += 1) {
    const debit = `d${n}`;
    const credit = `c${n}`;
    if (stableUuid(`${CREDIT_TX}:${credit}`) < stableUuid(`${DEBIT_TX}:${debit}`)) return { debit, credit };
  }
  throw new Error('no same-millisecond id pair');
}

const LINES = lineIds();

function scriptSql(): Sql {
  return (async (strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (text.includes('FROM pay.merchants')) return [{ user_id: USER }];
    if (text.includes("e.event = 'captured'")) {
      return [
        { id: PAY_DEBIT, currency: 'USDT' },
        { id: PAY_CREDIT, currency: 'USDT' },
      ];
    }
    if (text.includes('FROM pay.settlements')) return [];
    if (text.includes("e.event = 'refund.posted'")) return [];
    if (text.includes('chargeback.opening_planned')) return [];
    if (text.includes('pay.payout_admissions')) return [];
    throw new Error(text);
  }) as unknown as Sql;
}

function accountId(ref: AccountRef): string {
  if (ref.ownerId.startsWith('pay:clearing:')) return 'clearing';
  if (ref.ownerId.startsWith('pay:proceeds:')) return 'proceeds';
  if (ref.ownerType === 'user') return 'personal';
  return 'fees';
}

function entry(id: string, txId: string, direction: 'debit' | 'credit', amount: string): PostedEntry {
  return {
    id,
    txId,
    accountId: 'clearing',
    assetId: 'USDT',
    direction,
    amount: parseAmount(amount),
    balanceAfter: parseAmount(amount),
  };
}

function posted(input: {
  id: string;
  key: string;
  hash: string;
  previousHash: string | null;
  entryId: string;
  direction: 'debit' | 'credit';
  amount: string;
  seq?: number;
}): LedgerTx {
  const tx: LedgerTx & { seq?: number } = {
    id: input.id,
    idempotencyKey: input.key,
    module: 'pay',
    reason: 'payment.captured',
    meta: {},
    postedAt: AT,
    hash: input.hash,
    previousHash: input.previousHash,
    entries: [entry(input.entryId, input.id, input.direction, input.amount)],
  };
  if (input.seq !== undefined) tx.seq = input.seq;
  return tx;
}

function reader(txs: LedgerTx[], balanceAsOf?: (ref: AccountRef, at: Date) => Promise<Balance>) {
  const byKey = new Map(txs.map((tx) => [tx.idempotencyKey, tx]));
  return {
    async balance(ref: AccountRef): Promise<Balance> {
      return { account: ref, accountId: accountId(ref), amount: 0n };
    },
    async getTxByKey(key: string): Promise<LedgerTx | null> {
      return byKey.get(key) ?? null;
    },
    balanceAsOf,
  };
}

describe('statement same-millisecond order', () => {
  it('orders two posts in one millisecond by the hash chain and keeps the running balance', async () => {
    const txs = [
      posted({
        id: DEBIT_TX,
        key: `payment.capture:${PAY_DEBIT}`,
        hash: 'hash-debit',
        previousHash: null,
        entryId: LINES.debit,
        direction: 'debit',
        amount: '10',
      }),
      posted({
        id: CREDIT_TX,
        key: `payment.capture:${PAY_CREDIT}`,
        hash: 'hash-credit',
        previousHash: 'hash-debit',
        entryId: LINES.credit,
        direction: 'credit',
        amount: '4',
      }),
    ];
    const page = await listMerchantStatement(scriptSql(), reader(txs), RANGE, fail);
    expect(page.runningBalances).toBe('within_range');
    expect(page.opening).toBeNull();
    expect(page.items.find((line) => line.amount === '4')).toMatchObject({
      runningOrder: 'clear',
      runningClearing: '6',
      runningProceeds: '0',
    });
    expect(page.items.every((line) => line.runningOrder === 'clear')).toBe(true);
  });

  it('flags the line instead of failing the page when same-millisecond posts have no ledger order', async () => {
    const txs = [
      posted({
        id: DEBIT_TX,
        key: `payment.capture:${PAY_DEBIT}`,
        hash: 'hash-debit',
        previousHash: null,
        entryId: LINES.debit,
        direction: 'debit',
        amount: '10',
      }),
      posted({
        id: CREDIT_TX,
        key: `payment.capture:${PAY_CREDIT}`,
        hash: 'hash-credit',
        previousHash: null,
        entryId: LINES.credit,
        direction: 'credit',
        amount: '4',
      }),
    ];
    const page = await listMerchantStatement(scriptSql(), reader(txs), RANGE, fail);
    expect(page.items.some((line) => line.runningOrder === 'order_ambiguous' && line.runningClearing === null)).toBe(true);
  });

  it('orders two posts in one millisecond by the ledger sequence when the client exposes it', async () => {
    const txs = [
      posted({
        id: DEBIT_TX,
        key: `payment.capture:${PAY_DEBIT}`,
        hash: 'hash-debit',
        previousHash: null,
        entryId: LINES.debit,
        direction: 'debit',
        amount: '10',
        seq: 1,
      }),
      posted({
        id: CREDIT_TX,
        key: `payment.capture:${PAY_CREDIT}`,
        hash: 'hash-credit',
        previousHash: null,
        entryId: LINES.credit,
        direction: 'credit',
        amount: '4',
        seq: 2,
      }),
    ];
    const page = await listMerchantStatement(scriptSql(), reader(txs), RANGE, fail);
    expect(page.items.find((line) => line.amount === '4')).toMatchObject({ runningOrder: 'clear', runningClearing: '6' });
  });

  it('starts running balances from balance-as-of when the ledger exposes it', async () => {
    const seen: Date[] = [];
    const txs = [
      posted({
        id: DEBIT_TX,
        key: `payment.capture:${PAY_DEBIT}`,
        hash: 'hash-debit',
        previousHash: null,
        entryId: LINES.debit,
        direction: 'debit',
        amount: '1',
      }),
    ];
    const ledger = reader(txs, async (ref, at) => {
      seen.push(at);
      return {
        account: ref,
        accountId: accountId(ref),
        amount: ref.ownerId.startsWith('pay:clearing:') ? parseAmount('5') : 0n,
      };
    });
    const sql = (async (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      if (text.includes('FROM pay.merchants')) return [{ user_id: USER }];
      if (text.includes("e.event = 'captured'")) return [{ id: PAY_DEBIT, currency: 'USDT' }];
      if (text.includes('FROM pay.settlements')) return [];
      if (text.includes("e.event = 'refund.posted'")) return [];
      if (text.includes('chargeback.opening_planned')) return [];
      if (text.includes('pay.payout_admissions')) return [];
      throw new Error(text);
    }) as unknown as Sql;
    const page = await listMerchantStatement(sql, ledger, RANGE, fail);
    expect(page.runningBalances).toBe('from_opening');
    expect(page.opening).toEqual([{ assetId: 'USDT', clearing: '5', proceeds: '0' }]);
    expect(page.items[0]).toMatchObject({ runningOrder: 'clear', runningClearing: '6' });
    expect(seen.every((at) => at.toISOString() === RANGE.from)).toBe(true);
  });
});
