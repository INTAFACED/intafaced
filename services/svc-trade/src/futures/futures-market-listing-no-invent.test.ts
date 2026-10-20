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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { fakeMarket, presentCcxtMarket } from '../public-rest.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public-rest.ts'), 'utf8');
const presenter = src.match(/export function presentCcxtMarket[\s\S]*?^}/m)?.[0] ?? '';

describe('listed markets do not invent perp contract or funding fields', () => {
  it('extracts presentCcxtMarket', () => {
    expect(presenter).toMatch(/export function presentCcxtMarket/);
  });

  it('reads contractSize and settle only from the stored listing; expiry is listed dated or null; leverage min is null', () => {
    expect(presenter).toMatch(/contractSize:\s*isFutures && market\.contractSize != null \? formatAmount\(market\.contractSize\)/);
    expect(presenter).not.toMatch(/contractSize:\s*'\d/);
    expect(presenter).toMatch(/settle:\s*settleAsset/);
    expect(presenter).toMatch(/listedExpiry \? listedExpiry\.getTime\(\) : \(null as number \| null\)/);
    expect(presenter).not.toMatch(/expiry:\s*\d+/);
    expect(presenter).toMatch(/min:\s*null as string \| null/);
  });

  it('leaves contractSize null until the listing recorded one, and publishes it exactly as stored', () => {
    const bare = fakeMarket({ symbol: 'BTC/USDT-PERP', kind: 'futures' });
    expect(presentCcxtMarket(bare).contractSize).toBeNull();
    expect(presentCcxtMarket({ ...bare, contractSize: parseAmount('0.01') }).contractSize).toBe('0.01');
    // Spot never carries a contract multiplier.
    expect(presentCcxtMarket({ ...fakeMarket({ symbol: 'BTC/USDT' }), contractSize: parseAmount('0.01') }).contractSize).toBeNull();
  });

  it('does not attach a funding quote to the listing', () => {
    expect(presenter).not.toMatch(/fundingRate/);
    expect(presenter).not.toMatch(/nextFundingTimestamp/);
    expect(presenter).not.toMatch(/indexPrice/);
  });
});
