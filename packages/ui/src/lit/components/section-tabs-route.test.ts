// The section tab bar lights the route's own tab (intafaced issue 10303): the beta lit Transfers on Direct debits,
// Strategies on Shared with me and Execution on the terminal, because each room named its tab by hand.
import { describe, expect, it } from 'vitest';
import { currentTab } from './b2-basics.js';

const bank = ['/bank', '/bank/spaces', '/bank/transfers', '/bank/earn', '/bank/ramps'].map((href) => ({ label: href, href }));
const quant = ['/quant', '/quant/strategies', '/quant/shared', '/quant/library', '/quant/limits'].map((href) => ({
  label: href,
  href: `${href}?paper=1`,
}));
const trade = [
  { label: 'Spot', href: '/trade/spot/BTC-USDT', match: ['/trade/spot'] },
  { label: 'Margin', href: '/trade/margin' },
  { label: 'Execution', href: '/execution', match: ['/execution'] },
];

describe('currentTab', () => {
  it('lights the tab whose path is the route', () => {
    expect(currentTab(bank, '/bank')).toBe('/bank');
    expect(currentTab(bank, '/bank/transfers')).toBe('/bank/transfers');
    expect(currentTab(quant, '/quant/shared')).toBe('/quant/shared?paper=1');
    expect(currentTab(quant, '/quant/limits/')).toBe('/quant/limits?paper=1');
  });

  it('lights the tab a detail page sits under', () => {
    expect(currentTab(bank, '/bank/earn/pool')).toBe('/bank/earn');
    expect(currentTab(quant, '/quant/strategies/abc')).toBe('/quant/strategies?paper=1');
    expect(currentTab(quant, '/quant/shared/abc')).toBe('/quant/shared?paper=1');
    expect(currentTab(trade, '/trade/spot/ETH-USDT')).toBe('/trade/spot/BTC-USDT');
    expect(currentTab(trade, '/execution/abc')).toBe('/execution');
  });

  it('lights no tab on a room the bar does not list, never a neighbour or the section root', () => {
    expect(currentTab(bank, '/bank/direct-debits')).toBe('');
    expect(currentTab(bank, '/bank/calendar')).toBe('');
    expect(currentTab(bank, '/bank/account')).toBe('');
    expect(currentTab(quant, '/quant/backtest')).toBe('');
    expect(currentTab(trade, '/trade/terminal')).toBe('');
    expect(currentTab(trade, '/trade/marginal')).toBe('');
  });
});
