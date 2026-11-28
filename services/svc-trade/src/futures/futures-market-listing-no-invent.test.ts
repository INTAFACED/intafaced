/**
 * Unit card — fetchMarkets must not invent perp contract or funding fields
 * 1. Promise: presentCcxtMarket publishes contractSize only from the stored listing (D-instruments-03 exposes it;
 *    a row that never recorded one stays null) and hard-nulls leverage min; no funding quote
 * 2. Break: listing copies 1 as contractSize or puts fundingRate / nextFunding on the market
 * 3. Done bar: contractSize is null unless stored; the other fields are null or absent on the presenter
 * 4. Class N
 * 5. Paths: svc-trade/src/public-rest.ts
 * 6. RED: contractSize: '1' or fundingRate: inside presentCcxtMarket
 * 7. Collision: none — #1930 pins presentTicker 24h; this pins the market listing
 */

import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { fakeMarket, presentCcxtMarket } from '../public-rest.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('listed markets do not invent perp contract or funding fields', () => {
  it('reads contractSize and settle only from the stored listing; expiry is listed dated or null; leverage min is null', () => {
    const perp = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' }), 0, { futuresMaxLeverage: '5' });
    expect(perp).toMatchObject({ settle: null, settleAsset: null, expiry: null, expiryDatetime: null, type: 'swap' });
    expect(perp.limits.leverage.min).toBeNull();
    const expiry = new Date('2026-12-26T08:00:00.000Z');
    const dated = presentCcxtMarket(
      {
        ...fakeMarket({ symbol: 'BTC/USDT-261226', kind: 'futures' }),
        futuresContractStyle: 'dated',
        futuresExpiryAt: expiry,
        futuresSettleAsset: 'USDT',
      },
      0,
    );
    expect(dated).toMatchObject({ type: 'future', expiry: expiry.getTime(), expiryDatetime: expiry.toISOString(), settle: 'USDT' });
    // A dated style with no recorded expiry lists no expiry rather than a made-up one.
    const undated = presentCcxtMarket(
      { ...fakeMarket({ symbol: 'BTC/USDT-X', kind: 'futures' }), futuresContractStyle: 'dated', futuresExpiryAt: null },
      0,
    );
    expect(undated.expiry).toBeNull();
  });

  it('leaves contractSize null until the listing recorded one, and publishes it exactly as stored', () => {
    const bare = fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' });
    expect(presentCcxtMarket(bare).contractSize).toBeNull();
    expect(presentCcxtMarket({ ...bare, contractSize: parseAmount('0.01') }).contractSize).toBe('0.01');
    // Spot never carries a contract multiplier.
    expect(presentCcxtMarket({ ...fakeMarket({ symbol: 'BTC/USDT' }), contractSize: parseAmount('0.01') }).contractSize).toBeNull();
  });

  it('does not attach a funding quote to the listing', () => {
    const wire = presentCcxtMarket(fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' }), 0, {
      futuresOrderable: true,
      futuresMaxLeverage: '5',
    });
    expect(wire).not.toHaveProperty('fundingRate');
    expect(wire).not.toHaveProperty('nextFundingTimestamp');
    expect(wire).not.toHaveProperty('indexPrice');
    expect(JSON.stringify(wire)).not.toMatch(/fundingRate|nextFundingTimestamp|indexPrice/);
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const src = readFileSync(join(here, '..', 'public-rest.ts'), 'utf8');

  const presenter = src.match(/export function presentCcxtMarket[\s\S]*?^}/m)?.[0] ?? '';

  it('extracts presentCcxtMarket (kept source pin)', () => {
    expect(presenter).toMatch(/export function presentCcxtMarket/);
  });

  it('reads contractSize and settle only from the stored listing; expiry is listed dated or null; leverage min is null (kept source pin)', () => {
    expect(presenter).toMatch(/contractSize:\s*isFutures && market\.contractSize != null \? formatAmount\(market\.contractSize\)/);
    expect(presenter).not.toMatch(/contractSize:\s*'\d/);
    expect(presenter).toMatch(/settle:\s*settleAsset/);
    expect(presenter).toMatch(/listedExpiry \? listedExpiry\.getTime\(\) : \(null as number \| null\)/);
    expect(presenter).not.toMatch(/expiry:\s*\d+/);
    expect(presenter).toMatch(/min:\s*null as string \| null/);
  });

  it('does not attach a funding quote to the listing (kept source pin)', () => {
    expect(presenter).not.toMatch(/fundingRate/);
    expect(presenter).not.toMatch(/nextFundingTimestamp/);
    expect(presenter).not.toMatch(/indexPrice/);
  });
});
