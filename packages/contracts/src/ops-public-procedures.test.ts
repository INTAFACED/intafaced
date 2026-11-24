import { describe, expect, it } from 'vitest';
import { OPS_HOME_CONFIG, OPS_VALUATION_PRICES } from './ops-public-procedures.js';
import { replyAccepted } from './procedure.js';
import { workItemKindSchema } from './home-work-items.js';

// The refinements the reply schemas used to carry now sit in each record's `accept`, which every caller runs: a reply that
// breaks one still reads as unverified, never as data.
const config = {
  workListCap: 5,
  workListOrder: [workItemKindSchema.options[0]],
  searchResultCap: 3,
  noticeStripLimit: null,
  recentActivityLimit: null,
  revision: 0,
};
const prices = (rows: { asset: string; usd: string }[]) => ({
  published: true,
  test: true,
  source: 'TEST price list',
  asOf: '2026-11-19T00:00:00.000Z',
  prices: rows,
});

describe("svc-ops' public records keep their reply rules", () => {
  it('home.config: a kind listed twice is refused, once or blank is accepted', () => {
    const kind = OPS_HOME_CONFIG.output.parse(config).workListOrder?.[0];
    expect(kind).toBeDefined();
    expect(replyAccepted(OPS_HOME_CONFIG, OPS_HOME_CONFIG.output.parse(config))).toBe(true);
    expect(replyAccepted(OPS_HOME_CONFIG, OPS_HOME_CONFIG.output.parse({ ...config, workListOrder: null }))).toBe(true);
    expect(replyAccepted(OPS_HOME_CONFIG, OPS_HOME_CONFIG.output.parse({ ...config, workListOrder: [kind, kind] }))).toBe(false);
  });

  it('valuation.prices: a zero price or an asset priced twice is refused', () => {
    const ok = OPS_VALUATION_PRICES.output.parse(prices([{ asset: 'USDC', usd: '1' }]));
    expect(replyAccepted(OPS_VALUATION_PRICES, ok)).toBe(true);
    expect(replyAccepted(OPS_VALUATION_PRICES, { published: false, code: 'valuation.prices_unset' })).toBe(true);
    expect(replyAccepted(OPS_VALUATION_PRICES, OPS_VALUATION_PRICES.output.parse(prices([{ asset: 'USDC', usd: '0.00' }])))).toBe(false);
    const twice = prices([
      { asset: 'USDC', usd: '1' },
      { asset: 'USDC', usd: '1' },
    ]);
    expect(replyAccepted(OPS_VALUATION_PRICES, OPS_VALUATION_PRICES.output.parse(twice))).toBe(false);
  });
});
