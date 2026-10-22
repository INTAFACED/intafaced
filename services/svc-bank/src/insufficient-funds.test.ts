import { describe, expect, it } from 'vitest';
import { InsufficientFundsError, LedgerError, parseAmount, type Balance } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { BankInsufficientFundsError, SpendFiguresReader } from './insufficient-funds.js';
import { BankError } from './errors.js';

const USER = '11111111-1111-4111-8111-111111111111';

function bal(assetId: string, kind: 'available' | 'hold' | 'stake', amount: string, ownerId = USER): Balance {
  return {
    account: { ownerType: 'user', ownerId, assetId, kind },
    accountId: `${ownerId}:${assetId}:${kind}`,
    amount: parseAmount(amount),
  } as Balance;
}

type EarnRow = { userId: string; assetId: string; status: string; principal: string };

/** A tagged-template stand-in for postgres.js that answers the one earn query from rows, filtered by its bound values. */
function fakeSql(rows: EarnRow[] | Error, seen: unknown[][] = []): Sql {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    seen.push(values);
    if (rows instanceof Error) return Promise.reject(rows);
    const [userId, assetId] = values;
    expect(strings.join('?')).toContain("status = 'active'");
    return Promise.resolve(
      rows.filter((r) => r.userId === userId && r.assetId === assetId && r.status === 'active').map((r) => ({ principal: r.principal })),
    );
  };
  return fn as unknown as Sql;
}

const ledgerOf = (rows: Balance[] | Error, calls: string[] = []) => ({
  balances: async (ownerType: string, ownerId: string) => {
    calls.push(`${ownerType}:${ownerId}`);
    if (rows instanceof Error) throw rows;
    return rows.filter((r) => r.account.ownerId === ownerId);
  },
});

const refused = () => new InsufficientFundsError('acct', 'USDT', '12', '10');

describe('RC-wallet-09 insufficient-funds figures', () => {
  it('names 10 available, 5 on hold and 20 in earn exactly, as decimal strings', async () => {
    const reader = new SpendFiguresReader(
      fakeSql([
        { userId: USER, assetId: 'USDT', status: 'active', principal: '12.5' },
        { userId: USER, assetId: 'USDT', status: 'active', principal: '7.5' },
        { userId: USER, assetId: 'USDT', status: 'closed', principal: '99' },
      ]),
      ledgerOf([bal('USDT', 'available', '10'), bal('USDT', 'hold', '5'), bal('USDT', 'stake', '20')]),
    );
    const out = await reader.refusal(refused(), USER, 'USDT');
    expect(out).toBeInstanceOf(BankInsufficientFundsError);
    expect(out).toBeInstanceOf(BankError);
    const err = out as BankInsufficientFundsError;
    expect(err.code).toBe('bank.insufficient_funds');
    expect(err.data).toEqual({ assetId: 'USDT', available: '10', onHold: '5', inEarn: '20' });
    for (const v of [err.data!.available, err.data!.onHold, err.data!.inEarn]) expect(typeof v).toBe('string');
  });

  it('keeps sub-unit precision (no JS number on the way)', async () => {
    const reader = new SpendFiguresReader(
      fakeSql([{ userId: USER, assetId: 'ETH', status: 'active', principal: '0.000000000000000001' }]),
      ledgerOf([bal('ETH', 'available', '123456789012345678.123456789012345678')]),
    );
    expect(await reader.read(USER, 'ETH')).toEqual({
      assetId: 'ETH',
      available: '123456789012345678.123456789012345678',
      onHold: '0',
      inEarn: '0.000000000000000001',
    });
  });

  it('when the earn read fails, still refuses with inEarn null rather than a guessed zero', async () => {
    const reader = new SpendFiguresReader(
      fakeSql(new Error('db down')),
      ledgerOf([bal('USDT', 'available', '10'), bal('USDT', 'hold', '5')]),
    );
    const err = (await reader.refusal(refused(), USER, 'USDT')) as BankInsufficientFundsError;
    expect(err.code).toBe('bank.insufficient_funds');
    expect(err.data).toEqual({ assetId: 'USDT', available: '10', onHold: '5', inEarn: null });
  });

  it('when the balance read fails, refuses plain bank.insufficient_funds with no figures and never a zero', async () => {
    const seen: unknown[][] = [];
    const reader = new SpendFiguresReader(fakeSql([], seen), ledgerOf(new Error('ledger down')));
    const err = (await reader.refusal(refused(), USER, 'USDT')) as BankInsufficientFundsError;
    expect(err.code).toBe('bank.insufficient_funds');
    expect(err.figures).toBeNull();
    expect(err.data).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('with a second asset, returns only the refused asset amounts', async () => {
    const reader = new SpendFiguresReader(
      fakeSql([
        { userId: USER, assetId: 'USDT', status: 'active', principal: '20' },
        { userId: USER, assetId: 'BTC', status: 'active', principal: '3' },
      ]),
      ledgerOf([bal('USDT', 'available', '10'), bal('USDT', 'hold', '5'), bal('BTC', 'available', '1'), bal('BTC', 'hold', '2')]),
    );
    expect(await reader.read(USER, 'BTC')).toEqual({ assetId: 'BTC', available: '1', onHold: '2', inEarn: '3' });
  });

  it("reads only the caller's own book and earn rows", async () => {
    const calls: string[] = [];
    const seen: unknown[][] = [];
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const reader = new SpendFiguresReader(
      fakeSql([{ userId: OTHER, assetId: 'USDT', status: 'active', principal: '500' }], seen),
      ledgerOf([bal('USDT', 'available', '900', OTHER), bal('USDT', 'available', '10')], calls),
    );
    expect(await reader.read(USER, 'USDT')).toEqual({ assetId: 'USDT', available: '10', onHold: '0', inEarn: '0' });
    expect(calls).toEqual([`user:${USER}`]);
    expect(seen[0]?.[0]).toBe(USER);
  });

  it('maps a coded LedgerError ledger.insufficient_funds the same way', async () => {
    const reader = new SpendFiguresReader(fakeSql([]), ledgerOf([bal('USDT', 'available', '1')]));
    const err = (await reader.refusal(new LedgerError('no', 'ledger.insufficient_funds'), USER, 'USDT')) as BankError;
    expect(err.code).toBe('bank.insufficient_funds');
  });

  it('passes every other error through untouched and reads nothing', async () => {
    const calls: string[] = [];
    const reader = new SpendFiguresReader(fakeSql([]), ledgerOf([], calls));
    const other = new LedgerError('bad', 'ledger.invalid_entry');
    expect(await reader.refusal(other, USER, 'USDT')).toBe(other);
    const bank = new BankError('x', 'bank.space_locked');
    expect(await reader.refusal(bank, USER, 'USDT')).toBe(bank);
    expect(calls).toEqual([]);
  });
});
