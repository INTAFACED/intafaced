import { describe, expect, it } from 'vitest';
import { InsufficientFundsError } from '@intafaced/ledger-client';
import { rehydrateLedgerHttpError } from '@intafaced/ledger-client';
import { createLedgerClient } from './ledger-client.js';

describe('rehydrateLedgerHttpError (P2P-01)', () => {
  it('rebuilds InsufficientFundsError from structured s2s body', () => {
    const err = rehydrateLedgerHttpError(
      '/trpc/post',
      400,
      JSON.stringify({
        message: 'Insufficient USDT: requested 10, available 0',
        code: 'ledger.insufficient_funds',
        accountId: 'acct-1',
        assetId: 'USDT',
        requested: '10',
        availableBalance: '0',
      }),
    );
    expect(err).toBeInstanceOf(InsufficientFundsError);
    const funds = err as InsufficientFundsError;
    expect(funds.assetId).toBe('USDT');
    expect(funds.requested).toBe('10');
    expect(funds.availableBalance).toBe('0');
    expect(funds.accountId).toBe('acct-1');
  });

  it('rebuilds from message text when code is embedded only in the string', () => {
    const err = rehydrateLedgerHttpError('/trpc/post', 400, JSON.stringify({ message: 'Insufficient BTC: requested 1, available 0.1' }));
    expect(err).toBeInstanceOf(InsufficientFundsError);
    const funds = err as InsufficientFundsError;
    expect(funds.assetId).toBe('BTC');
    expect(funds.requested).toBe('1');
    expect(funds.availableBalance).toBe('0.1');
  });

  it('leaves non-funds failures as plain Error', () => {
    const err = rehydrateLedgerHttpError('/trpc/post', 500, '{"message":"boom"}');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InsufficientFundsError);
    expect(err.message).toMatch(/svc-ledger/);
  });
});

describe('P2P ledger transport budget', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 2_147_483_648, null as unknown as number, '15' as unknown as number])(
    'refuses invalid timeoutMs %s instead of disabling its deadline',
    (timeoutMs) => {
      expect(() => createLedgerClient('http://fixture.invalid', 'synthetic-p2p-fixture-internal-secret', { timeoutMs })).toThrow(
        RangeError,
      );
    },
  );
});
