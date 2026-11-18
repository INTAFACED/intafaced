import { describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { OwnFundsCustomerRowError, OwnFundsPlaceRowError, serializeOwnFunds, type OwnFundsRow } from './own-funds.js';

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
    expect(serializeOwnFunds(AT, [row({ balance: amt('12.5') })], [])).toEqual({
      asOf: AT.toISOString(),
      accounts: [{ ownerType: 'house', ownerId: 'fees:trade', assetId: 'USDT', kind: 'available', purpose: '', balance: '12.5' }],
      places: [],
    });
  });

  it('refuses rather than count a merchant pot or the burn account as ours', () => {
    expect(() => serializeOwnFunds(AT, [row({ ownerType: 'module', ownerId: 'pay:clearing:m-1' })], [])).toThrow(OwnFundsCustomerRowError);
    expect(() => serializeOwnFunds(AT, [row({ ownerType: 'module', ownerId: 'pay:proceeds:m-1' })], [])).toThrow(OwnFundsCustomerRowError);
    expect(() => serializeOwnFunds(AT, [row({ ownerId: 'burn' })], [])).toThrow(OwnFundsCustomerRowError);
    expect(() => serializeOwnFunds(AT, [row({ ownerId: 'futures-loss' })], [])).toThrow(OwnFundsCustomerRowError);
    expect(() => serializeOwnFunds(AT, [row({ ownerType: 'module', ownerId: 'ops:hold-confirm:x' })], [])).toThrow(
      OwnFundsCustomerRowError,
    );
    expect(() => serializeOwnFunds(AT, [row({ ownerType: 'module', ownerId: 'campaigns:lock:r1' })], [])).toThrow(OwnFundsCustomerRowError);
  });

  it('drops an account at zero instead of answering a zero row', () => {
    expect(serializeOwnFunds(AT, [row({ balance: 0n })], []).accounts).toEqual([]);
  });

  it('answers each own-funds place with what the book shows of ours there, at zero included (OWNER 288)', () => {
    const out = serializeOwnFunds(
      AT,
      [],
      [
        { ownerId: 'venue-builder-account:test-venue', assetId: 'USDC', balance: amt('-1.5') },
        { ownerId: 'partner-reserve:bank', assetId: 'USD', balance: 0n },
        { ownerId: 'treasury-wallet:base:ops', assetId: 'USDC', balance: amt('-0.000000000000000001') },
      ],
    );
    expect(out.places).toEqual([
      { kind: 'venue_builder_account', placeId: 'test-venue', assetId: 'USDC', held: '1.5' },
      { kind: 'partner_reserve', placeId: 'bank', assetId: 'USD', held: '0' },
      { kind: 'treasury_wallet', placeId: 'base:ops', assetId: 'USDC', held: '0.000000000000000001' },
    ]);
  });

  it('refuses a place row that is not a place, has no id, or shows less than nothing of ours', () => {
    expect(() => serializeOwnFunds(AT, [], [{ ownerId: 'venue-builder-fee:test-venue', assetId: 'USDC', balance: 0n }])).toThrow(
      OwnFundsPlaceRowError,
    );
    expect(() => serializeOwnFunds(AT, [], [{ ownerId: 'rail:crypto-native', assetId: 'USDC', balance: 0n }])).toThrow(
      OwnFundsPlaceRowError,
    );
    expect(() => serializeOwnFunds(AT, [], [{ ownerId: 'partner-reserve:', assetId: 'USD', balance: 0n }])).toThrow(OwnFundsPlaceRowError);
    expect(() => serializeOwnFunds(AT, [], [{ ownerId: 'partner-reserve:bank', assetId: 'USD', balance: amt('1') }])).toThrow(
      OwnFundsPlaceRowError,
    );
  });
});
