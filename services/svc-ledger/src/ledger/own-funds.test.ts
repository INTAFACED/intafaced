import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { OwnFundsCustomerRowError, serializeOwnFunds, type OwnFundsRow } from './own-funds.js';

const AT = new Date('2026-11-09T00:00:00.000Z');
const row = (over: Partial<OwnFundsRow>): OwnFundsRow => ({
  ownerType: 'house',
  ownerId: 'fees:trade',
  assetId: 'USDT',
  kind: 'available',
  purpose: '',
  balance: amt('1'),
  ...over,
});

describe('serializeOwnFunds', () => {
  it('answers decimal strings and the read time', () => {
    expect(serializeOwnFunds(AT, [row({ balance: amt('12.5') })])).toEqual({
      asOf: AT.toISOString(),
      accounts: [{ ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available', purpose: '', balance: '12.5' }],
    });
  });

  it('refuses rather than count a merchant pot or the burn account as ours', () => {
    expect(() => serializeOwnFunds(AT, [row({ ownerType: 'module', ownerId: 'pay:clearing:m-1' })])).toThrow(OwnFundsCustomerRowError);
    expect(() => serializeOwnFunds(AT, [row({ ownerType: 'module', ownerId: 'pay:proceeds:m-1' })])).toThrow(OwnFundsCustomerRowError);
    expect(() => serializeOwnFunds(AT, [row({ ownerId: 'burn' })])).toThrow(OwnFundsCustomerRowError);
  });

  it('drops an account at zero instead of answering a zero row', () => {
    expect(serializeOwnFunds(AT, [row({ balance: 0n })]).accounts).toEqual([]);
  });
});
