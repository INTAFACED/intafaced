import { describe, expect, it } from 'vitest';
import { availableRow, earnFormFacts, earnLiveRows, loanFormFacts, loanLiveRows, maturityDate } from './form-preview';

const fmt = (value: string, asset: string) => `${value} ${asset}`;
const bps = (value: number) => `${value / 100}%`;
const holdings = [{ assetId: 'USDT', available: '554.62', held: null, quantity: '554.62' }];
const flexible = { name: 'Flexible USDT', assetId: 'USDT', kind: 'flexible' as const, aprBps: 500, termDays: null };
const fixedNoTerm = { name: 'Fixed ?', assetId: 'USDT', kind: 'fixed' as const, aprBps: 500, termDays: null };
const fixed = { name: 'Fixed 90', assetId: 'USDT', kind: 'fixed' as const, aprBps: 800, termDays: 90 };
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
  it('does not call a fixed pool with no stated term "Flexible"', () => {
    const rows = earnFormFacts(fixedNoTerm, availableRow('USDT', holdings, fmt), new Date('2026-10-17T00:00:00Z'), bps);
    expect(rows).toContainEqual(['Term', 'Fixed term, length not stated']);
    expect(rows.map(([label]) => label)).not.toContain('Matures');
    expect(earnLiveRows(fixedNoTerm, { amount: '1000' }, fmt)[0]?.[1]).toMatch(/doesn’t state/);
  });
  it('does not invent a balance', () => {
    expect(availableRow('BTC', holdings, fmt)[1]).toBe('No BTC balance returned');
    expect(availableRow('USDT', null, fmt)[1]).toBe('Balance unavailable right now');
  });
  it('labels the interest as an estimate and states the formula', () => {
    const rows = earnLiveRows(fixed, { amount: '1000' }, fmt);
    expect(rows[0]).toEqual(['Estimated interest', 'About 19.72 USDT (estimate)']); // 1000 x 8% x 90 / 365 = 19.726..., cut to cents
    expect(rows[1]?.[1]).toContain('Amount × APR × 90 days ÷ 365');
    expect(earnLiveRows(flexible, { amount: '' }, fmt)[0]?.[1]).toBe('Enter an amount to see an estimate');
    expect(earnLiveRows(flexible, { amount: '1000' }, fmt)[0]?.[1]).toBe('About 50 USDT (estimate)');
  });
});

describe('Open loan form facts', () => {
  it('shows the limits the product read supplies and says why price-based rows are missing', () => {
    const rows = loanFormFacts(product, availableRow('BTC', [{ ...holdings[0]!, assetId: 'BTC', available: '1.5' }], fmt), bps);
    expect(rows).toContainEqual(['Available to use', '1.5 BTC']);
    expect(rows).toContainEqual(['Margin call when', 'your loan reaches 70% of your collateral’s value']);
    expect(rows).toContainEqual(['Collateral is sold when', 'your loan reaches 85% of your collateral’s value']);
    expect(rows).toContainEqual(['Most you can borrow', '50% of your collateral’s value']);
    const price = rows.find(([label]) => label === 'Starting LTV and liquidation price');
    expect(price?.[1]).toMatch(/does not send the price it uses for your collateral/);
    // nothing numeric is shown for a figure that needs a price
    expect(price?.[1]).not.toMatch(/\d/);
  });
  it('estimates a year of daily-compounded interest, labelled as an estimate and not called simple', () => {
    const rows = loanLiveRows(product, { principal: '1000' }, fmt);
    expect(rows[0]).toEqual(['Estimated interest', 'About 94.16 USDT (estimate)']);
    expect(rows[1]?.[1]).toContain('added every day');
    expect(rows[1]?.[1]).toContain('growing balance');
    expect(rows[1]?.[1]).not.toMatch(/simple/i);
  });
  it('says "less than" instead of 0 for interest too small to show', () => {
    expect(loanLiveRows(product, { principal: '0.01' }, fmt)[0]?.[1]).toBe('Less than 0.01 USDT (estimate)');
  });
});
