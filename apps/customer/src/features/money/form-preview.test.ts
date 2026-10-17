import { describe, expect, it } from 'vitest';
import { availableRow, earnFormFacts, earnLiveRows, loanFormFacts, loanLiveRows, maturityDate } from './form-preview';

const fmt = (value: string, asset: string) => `${value} ${asset}`;
const bps = (value: number) => `${value / 100}%`;
const holdings = [{ assetId: 'USDT', available: '554.62', held: null, quantity: '554.62' }];
const flexible = { name: 'Flexible USDT', assetId: 'USDT', aprBps: 500, termDays: null };
const fixed = { name: 'Fixed 90', assetId: 'USDT', aprBps: 800, termDays: 90 };
const product = {
  name: 'USDT against BTC',
  debtAssetId: 'USDT',
  collateralAssetId: 'BTC',
  aprBps: 900,
  maxLtvBps: 5000,
  marginCallLtvBps: 7000,
  liquidationLtvBps: 8500,
};

describe('Earn deposit form facts', () => {
  it('shows balance, pool, APR and term from what the bank returned', () => {
    const rows = earnFormFacts(flexible, availableRow('USDT', holdings, fmt), new Date('2026-10-17T00:00:00Z'), bps);
    expect(rows).toContainEqual(['Available to use', '554.62 USDT']);
    expect(rows).toContainEqual(['Pool', 'Flexible USDT']);
    expect(rows).toContainEqual(['APR', '5%']);
    expect(rows.map(([label]) => label)).not.toContain('Matures');
  });
  it('gives an approximate maturity only for a fixed pool', () => {
    const rows = earnFormFacts(fixed, availableRow('USDT', holdings, fmt), new Date('2026-10-17T10:00:00Z'), bps);
    expect(rows).toContainEqual(['Matures', 'About 2027-01-15, if you deposit today']);
    expect(maturityDate(90, new Date('2026-10-17T23:59:00Z'))).toBe('2027-01-15');
  });
  it('does not invent a balance', () => {
    expect(availableRow('BTC', holdings, fmt)[1]).toBe('No BTC balance returned');
    expect(availableRow('USDT', null, fmt)[1]).toBe('Balance unavailable right now');
  });
  it('labels the interest as an estimate and states the formula', () => {
    const rows = earnLiveRows(fixed, { amount: '1000' }, fmt);
    expect(rows[0]).toEqual(['Estimated interest', 'About 19.72602739 USDT (estimate)']); // 1000 x 8% x 90 / 365
    expect(rows[1]?.[1]).toContain('Amount × APR × 90 days ÷ 365');
    expect(earnLiveRows(flexible, { amount: '' }, fmt)[0]?.[1]).toBe('Enter an amount to see an estimate');
    expect(earnLiveRows(flexible, { amount: '1000' }, fmt)[0]?.[1]).toBe('About 50 USDT (estimate)');
  });
});

describe('Open loan form facts', () => {
  it('shows the limits the product read supplies and says why price-based rows are missing', () => {
    const rows = loanFormFacts(product, availableRow('BTC', [{ ...holdings[0]!, assetId: 'BTC', available: '1.5' }], fmt), bps);
    expect(rows).toContainEqual(['Available to use', '1.5 BTC']);
    expect(rows).toContainEqual(['Margin call starts at', '70% of your collateral’s value']);
    expect(rows).toContainEqual(['Collateral is sold at', '85% of your collateral’s value']);
    const price = rows.find(([label]) => label === 'Starting LTV and liquidation price');
    expect(price?.[1]).toMatch(/doesn’t include the price/);
    // nothing numeric is shown for a figure that needs a price
    expect(price?.[1]).not.toMatch(/\d/);
  });
  it('estimates a year of interest on the amount borrowed, labelled as an estimate', () => {
    const rows = loanLiveRows(product, { principal: '1000' }, fmt);
    expect(rows[0]).toEqual(['Estimated interest', 'About 90 USDT (estimate)']);
    expect(rows[1]?.[1]).toContain('Amount borrowed × APR for one year');
  });
});
