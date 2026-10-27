import { describe, expect, it } from 'vitest';
import type { FuturesListing, PositionPreview } from './api';
import {
  contractsAllowed,
  contractsToBase,
  openBlock,
  overCap,
  percentSize,
  previewLiquidationDistance,
  previewsEqual,
  reviewBlock,
  sameForm,
  sizeInBase,
  sizePlaces,
  splitPreview,
  tierToConfirm,
} from './ticket-logic';

// TEST figures only: not market data.
const linear = { linear: true, contractSize: '0.001' } as Pick<FuturesListing, 'linear' | 'contractSize'>;
const preview: PositionPreview = {
  symbol: 'BTC/USDT:USDT',
  side: 'long',
  size: '0.5',
  leverage: '5',
  marginMode: 'isolated',
  markPrice: '100',
  markSource: null,
  leverageCap: '20',
  orderValue: '50',
  initialMargin: '10',
  estimatedFee: '0.05',
  liquidationPrice: '82.5',
  orderable: true,
  refusals: [],
};
const base = {
  planeOff: false,
  signedOut: false,
  locked: false,
  markKnown: true,
  markStale: false,
  preview,
  leverage: '5',
  free: '100',
};

describe('contracts and base size', () => {
  it('multiplies exactly', () => {
    expect(contractsToBase('3', linear)).toBe('0.003');
    expect(contractsToBase('0.1', { linear: true, contractSize: '0.3' })).toBe('0.03');
    expect(sizeInBase('1250', 'contracts', linear)).toBe('1.25');
  });
  it('refuses contracts for inverse, unknown or zero contract size', () => {
    expect(contractsAllowed({ linear: false, contractSize: '1' })).toBe(false);
    expect(contractsAllowed({ linear: null, contractSize: '1' })).toBe(false);
    expect(contractsAllowed({ linear: true, contractSize: null })).toBe(false);
    expect(contractsAllowed({ linear: true, contractSize: '0' })).toBe(false);
    expect(sizeInBase('3', 'contracts', { linear: false, contractSize: '1' })).toBeNull();
  });
  it('empty or unreadable input is unknown, not zero', () => {
    expect(sizeInBase('', 'base', linear)).toBeNull();
    expect(sizeInBase('.', 'base', linear)).toBeNull();
    expect(sizeInBase('0.50', 'base', linear)).toBe('0.5');
  });
  it('reads size places from the amount step', () => {
    expect(sizePlaces({ precision: { price: '0.01', amount: '0.001' } })).toBe(3);
  });
});

describe('percent of max', () => {
  const args = { free: '100', leverage: '5', mark: '100', pct: 50, unit: 'base' as const, places: 3 };
  it('is a share of free x leverage / mark', () => {
    expect(percentSize(args, linear)).toBe('2.5');
    expect(percentSize({ ...args, pct: 100 }, linear)).toBe('5');
  });
  it('cuts down rather than rounding up', () => {
    expect(percentSize({ ...args, mark: '300', pct: 100 }, linear)).toBe('1.666');
  });
  it('converts to contracts and cuts down', () => {
    expect(percentSize({ ...args, unit: 'contracts', pct: 100 }, linear)).toBe('5000');
  });
  it('is null when an input is unknown', () => {
    expect(percentSize({ ...args, free: null }, linear)).toBeNull();
    expect(percentSize({ ...args, leverage: '' }, linear)).toBeNull();
    expect(percentSize({ ...args, unit: 'contracts' }, { linear: false, contractSize: '1' })).toBeNull();
  });
});

describe('preview comparison', () => {
  it('equal previews match, any changed server value does not', () => {
    expect(previewsEqual(preview, { ...preview })).toBe(true);
    expect(previewsEqual(preview, { ...preview, estimatedFee: '0.06' })).toBe(false);
    expect(previewsEqual(preview, { ...preview, refusals: [{ code: 'x', field: 'size', message: 'm' }] })).toBe(false);
  });
  it('knows the form it was asked about', () => {
    const k = { symbol: 'A', side: 'long' as const, size: '1', leverage: '2' };
    expect(sameForm(k, { ...k })).toBe(true);
    expect(sameForm(k, { ...k, leverage: '3' })).toBe(false);
    expect(sameForm(k, { ...k, side: 'short' })).toBe(false);
    // Market is the default type; a limit's price and its correction are part of what was reviewed.
    expect(sameForm(k, { ...k, type: 'market' })).toBe(true);
    expect(sameForm({ ...k, type: 'limit', limitPrice: '99' }, { ...k, type: 'limit', limitPrice: '98' })).toBe(false);
    expect(sameForm({ ...k, type: 'limit', limitPrice: '99' }, { ...k, type: 'limit', limitPrice: '99', priceCorrection: 'adjust' })).toBe(
      false,
    );
  });
  it('a split is offered only when the max-order is the one refusal and the service named the children', () => {
    const over = {
      ...preview,
      orderable: false,
      split: { parts: 3, sizes: ['0.2', '0.2', '0.1'] },
      refusals: [{ code: 'trade.limit_max_order', field: 'size', message: 'm' }],
    };
    expect(splitPreview(over)).toMatchObject({ orderable: true, refusals: [] });
    expect(splitPreview({ ...over, split: null })).toBeNull();
    expect(splitPreview(preview)).toBeNull();
    // Another refusal stays: the split preview is not orderable, and Open's gate names it.
    const more = { ...over, refusals: [...over.refusals, { code: 'trade.slippage_cap_unset', field: 'slippage', message: 'm' }] };
    expect(splitPreview(more)).toMatchObject({ orderable: false, refusals: [{ code: 'trade.slippage_cap_unset' }] });
    expect(openBlock({ ...base, preview: splitPreview(more) })).toBe('notOrderable');
    expect(openBlock({ ...base, preview: splitPreview(over) })).toBeNull();
  });
  it('the tier to confirm is the projected tier only when the review asks for it', () => {
    const tier = { current: 1, projected: 3, maintenanceBps: 250, maintenanceRate: '0.025', notional: '650', confirmRequired: true };
    expect(tierToConfirm({ ...preview, riskTier: tier })).toBe(3);
    expect(tierToConfirm({ ...preview, riskTier: { ...tier, projected: 1, confirmRequired: false } })).toBeNull();
    expect(tierToConfirm({ ...preview, riskTier: null })).toBeNull();
    expect(tierToConfirm(preview)).toBeNull();
  });
  it('distance to liquidation follows the side', () => {
    expect(previewLiquidationDistance(preview)).toBe('17.50');
    expect(previewLiquidationDistance({ ...preview, side: 'short', liquidationPrice: '120' })).toBe('20.00');
    expect(previewLiquidationDistance({ ...preview, liquidationPrice: null })).toBeNull();
  });
  it('leverage over the cap', () => {
    expect(overCap('25', '20')).toBe(true);
    expect(overCap('20', '20')).toBe(false);
    expect(overCap('25', null)).toBe(false);
  });
});

describe('review and open gates', () => {
  const r = { planeOff: false, signedOut: false, markKnown: true, markStale: false, size: '1', leverage: '2' };
  it('review needs a fresh mark, a size and a leverage', () => {
    expect(reviewBlock(r)).toBeNull();
    expect(reviewBlock({ ...r, markStale: true })).toBe('markStale');
    expect(reviewBlock({ ...r, markKnown: false })).toBe('markUnknown');
    expect(reviewBlock({ ...r, size: null })).toBe('noSize');
    expect(reviewBlock({ ...r, size: '0' })).toBe('noSize');
    expect(reviewBlock({ ...r, leverage: '' })).toBe('noLeverage');
    expect(reviewBlock({ ...r, signedOut: true })).toBe('signedOut');
    expect(reviewBlock({ ...r, planeOff: true })).toBe('planeOff');
  });
  it('opens only when everything is known and fits', () => {
    expect(openBlock(base)).toBeNull();
  });
  it('names the first reason', () => {
    expect(openBlock({ ...base, planeOff: true, signedOut: true })).toBe('planeOff');
    expect(openBlock({ ...base, signedOut: true })).toBe('signedOut');
    expect(openBlock({ ...base, locked: true })).toBe('locked');
    expect(openBlock({ ...base, markStale: true })).toBe('markStale');
    expect(openBlock({ ...base, preview: null })).toBe('notReviewed');
  });
  it('refuses a preview that is not orderable or has holes', () => {
    expect(openBlock({ ...base, preview: { ...preview, orderable: false } })).toBe('notOrderable');
    expect(openBlock({ ...base, preview: { ...preview, refusals: [{ code: 'c', field: 'f', message: 'm' }] } })).toBe('notOrderable');
    expect(openBlock({ ...base, preview: { ...preview, liquidationPrice: null } })).toBe('missingFigures');
    expect(openBlock({ ...base, preview: { ...preview, leverageCap: null } })).toBe('missingFigures');
  });
  it('checks the free balance against margin plus fee', () => {
    expect(openBlock({ ...base, free: '10.05' })).toBeNull();
    expect(openBlock({ ...base, free: '10.04' })).toBe('insufficient');
    expect(openBlock({ ...base, free: null })).toBe('balanceUnknown');
  });
  it('stops leverage over the published cap', () => {
    expect(openBlock({ ...base, leverage: '25' })).toBe('overCap');
  });
});
