import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueWireError, decodeVenueWire, encodeVenueWire } from './user-venue-wire.js';
import type { PreparedVenueAction, UserVenueMarket } from './user-venue.js';

describe('user-venue wire', () => {
  const prepared: PreparedVenueAction = {
    venueId: 'v',
    account: { venueId: 'v', owner: '0xabc', subAccount: null },
    signer: { role: 'owner', address: '0xabc' },
    intent: { kind: 'approve_agent', agentAddress: '0xdef', agentName: 'bot', validUntil: new Date('2026-12-01T00:00:00.000Z') },
    nonce: '1762628400000000',
    venueClientOrderId: null,
    typedData: { message: { amount: 1, nonce: '1' } },
    digest: '0x1',
    builderFee: { builder: '0xb', feeBps: parseAmount('0.000000000000000001') },
    preparedAt: new Date('2026-11-08T19:00:00.000Z'),
  };

  it('round-trips every Amount as a decimal string and every Date as ISO, and leaves typedData untouched', () => {
    const json = JSON.parse(JSON.stringify(encodeVenueWire(prepared)));
    expect(json.builderFee.feeBps).toBe('0.000000000000000001');
    expect(json.intent.validUntil).toBe('2026-12-01T00:00:00.000Z');
    expect(decodeVenueWire(json)).toEqual(prepared);
    const asOf = decodeVenueWire<{ value: bigint; asOf: Date }>({ value: '12.5', asOf: '2026-11-08T19:00:00.000Z' });
    expect(asOf).toEqual({ value: parseAmount('12.5'), asOf: new Date('2026-11-08T19:00:00.000Z') });
  });

  it('reads the best prices as Amounts, and an empty side as null, so a market order is bounded in bigint', () => {
    const best = { symbol: 'BTC-PERP', bid: parseAmount('64999'), ask: null };
    expect(decodeVenueWire(JSON.parse(JSON.stringify(encodeVenueWire(best))))).toEqual(best);
    expect(() => decodeVenueWire({ bid: 64999 })).toThrow(/decimal string/);
  });

  it('refuses a JSON number in a money field', () => {
    expect(() => decodeVenueWire({ amount: 0.1 })).toThrow(VenueWireError);
    expect(() => decodeVenueWire({ intent: { price: 60000 } })).toThrow(/decimal string/);
    expect(() => decodeVenueWire({ amount: '1e5' })).toThrow(VenueWireError);
  });

  it('refuses anything but a decimal string (or null where the type allows it) in an Amount field', () => {
    for (const bad of [{}, [], true, null, ['1']]) {
      expect(() => decodeVenueWire({ intent: { amount: bad } })).toThrow(/amount must be a decimal string/);
    }
    expect(() => decodeVenueWire({ price: { value: '1' } })).toThrow(VenueWireError);
    expect(() => decodeVenueWire({ balances: [{ free: false }] })).toThrow(/free must be a decimal string/);
    expect(decodeVenueWire({ averagePrice: null, realisedPnl: null })).toEqual({ averagePrice: null, realisedPnl: null });
    // A venue market's own largest order: a decimal string, or null when the venue reports none; never a JSON number.
    expect(decodeVenueWire({ maxOrderQty: '5', maxOrderNotional: null })).toEqual({
      maxOrderQty: parseAmount('5'),
      maxOrderNotional: null,
    });
    expect(() => decodeVenueWire({ maxOrderQty: 5 })).toThrow(/decimal string/);
    expect(() => decodeVenueWire({ maxOrderNotional: { value: '1' } })).toThrow(VenueWireError);
    // A name some type also uses for an object still decodes field by field.
    expect(decodeVenueWire({ builderFee: { builder: '0xb', feeBps: '1' }, fee: { known: true, value: '0.5' } })).toEqual({
      builderFee: { builder: '0xb', feeBps: parseAmount('1') },
      fee: { known: true, value: parseAmount('0.5') },
    });
  });

  it("round-trips a market's published words as text, its feed time as a Date, and keeps an unpublished rule unknown", () => {
    const market: UserVenueMarket = {
      symbol: 'XAU-PERP',
      kind: 'perpetual',
      baseAsset: 'XAU',
      quoteAsset: 'USDC',
      orderTypes: ['limit', 'market'],
      timeInForce: ['GTC', 'IOC'],
      marginModes: ['isolated'],
      maxLeverageBps: 100_000,
      tickSize: parseAmount('0.1'),
      lotSize: parseAmount('0.01'),
      makerFeeBps: { known: true, value: parseAmount('1.5') },
      takerFeeBps: { known: false },
      status: 'trading',
      maxOrderQty: null,
      maxOrderNotional: null,
      builderFeeCapBps: { known: false },
      listedBy: { known: true, value: { kind: 'hip3', name: 'TEST deployer' } },
      // Text that reads like a number stays text: a rule is never money.
      oracleRule: { known: true, value: '3' },
      markRule: { known: false },
      tradingHours: { known: true, value: '24/7, no close' },
      feed: {
        known: true,
        value: { state: 'stale', lastOracleUpdateAt: new Date('2026-11-09T10:00:00.000Z'), staleRule: { known: true, value: '10' } },
      },
    };
    const json = JSON.parse(JSON.stringify(encodeVenueWire(market)));
    expect(json.feed.value.lastOracleUpdateAt).toBe('2026-11-09T10:00:00.000Z');
    expect(json.oracleRule).toEqual({ known: true, value: '3' });
    const back = decodeVenueWire<UserVenueMarket>(json);
    expect(back).toEqual(market);
    expect(typeof (back.oracleRule as { value: unknown }).value).toBe('string');
    expect(back.markRule).toEqual({ known: false });
  });
});
