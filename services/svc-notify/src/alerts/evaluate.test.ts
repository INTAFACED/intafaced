/**
 * Unit card — v22.alerts MVP evaluate
 * 1. Promise: tracker v22.alerts + §31 — dark sources refuse; no invent
 * 2. Break: fire on null mark / silent drop when dark
 * 3. Done bar: unavailable → refuse; cross → fire; hold otherwise; no number money
 * 4. Class N (pure; no money movement)
 * 5. Paths: services/svc-notify/src/alerts/**
 * 6. RED first: dark quote must not fire
 * 7. Collision: none (new files)
 */

import { describe, expect, it } from 'vitest';
import { compareDecimalStrings, isValidPositivePrice } from './decimal.js';
import { evaluatePortfolioAlert, evaluatePriceAlert, evaluateUnpublishedKind, evaluateWhaleAlert } from './evaluate.js';
import {
  ALERT_KIND_UNPUBLISHED,
  ALERT_PORTFOLIO_VIEW_UNPUBLISHED,
  ALERTS_WHALE_MARK_DARK,
  UNPUBLISHED_ALERT_KINDS,
  type PriceAlert,
} from './types.js';

const base: PriceAlert = {
  id: '00000000-0000-4000-8000-000000000001',
  userId: 'user-1',
  marketId: 'BTC-USD',
  kind: 'price',
  direction: 'above',
  targetPrice: '100.5',
  status: 'active',
  firedAt: null,
  createdAt: new Date('2026-08-09T00:00:00Z'),
  condition: 'greater_than',
  name: null,
  message: null,
  expiresAt: null,
  lastSide: null,
  extras: [],
  updatedAt: new Date('2026-10-17T08:00:00Z'),
  frequency: 'once',
  fireCount: 0,
  stopReason: null,
  burstStartedAt: null,
  burstCount: 0,
  lastFiredAt: null,
  source: 'mark',
};

describe('decimal string compare — no JS number', () => {
  it('orders magnitudes without floating point', () => {
    expect(compareDecimalStrings('99.9', '100')).toBe(-1);
    expect(compareDecimalStrings('100.0', '100')).toBe(0);
    expect(compareDecimalStrings('100.01', '100')).toBe(1);
    expect(compareDecimalStrings('1000', '999')).toBe(1);
    expect(compareDecimalStrings('0.001', '0.01')).toBe(-1);
  });

  it('rejects non-prices as targets', () => {
    expect(isValidPositivePrice('0')).toBe(false);
    expect(isValidPositivePrice('-1')).toBe(false);
    expect(isValidPositivePrice('1e3')).toBe(false);
    expect(isValidPositivePrice('100.5')).toBe(true);
  });
});

describe('evaluatePriceAlert — dark refuse + cross fire', () => {
  it('refuses a dark mark and never fires', () => {
    const out = evaluatePriceAlert(base, { kind: 'unavailable', reason: 'dark' });
    expect(out).toEqual({
      kind: 'refuse',
      code: 'alert.price_unavailable',
      detail: 'dark',
    });
  });

  it('refuses stale and refused marks the same way', () => {
    expect(evaluatePriceAlert(base, { kind: 'unavailable', reason: 'stale', detail: 'mark age > 30s' }).kind).toBe('refuse');
    expect(evaluatePriceAlert(base, { kind: 'unavailable', reason: 'refused' }).kind).toBe('refuse');
  });

  it('fires when mark is at or above target for direction=above', () => {
    expect(evaluatePriceAlert(base, { kind: 'ok', price: '100.5', at: new Date() })).toEqual({
      kind: 'fire',
      markPrice: '100.5',
    });
    expect(evaluatePriceAlert(base, { kind: 'ok', price: '101', at: new Date() }).kind).toBe('fire');
  });

  it('holds when mark is still below an above-target', () => {
    expect(evaluatePriceAlert(base, { kind: 'ok', price: '100.49', at: new Date() })).toEqual({
      kind: 'hold',
      markPrice: '100.49',
    });
  });

  it('fires below-target when mark drops to or under', () => {
    const below: PriceAlert = { ...base, direction: 'below', targetPrice: '50' };
    expect(evaluatePriceAlert(below, { kind: 'ok', price: '50', at: new Date() }).kind).toBe('fire');
    expect(evaluatePriceAlert(below, { kind: 'ok', price: '49.9', at: new Date() }).kind).toBe('fire');
    expect(evaluatePriceAlert(below, { kind: 'ok', price: '50.1', at: new Date() }).kind).toBe('hold');
  });

  it('refuses inactive / already-fired / cancelled rather than re-firing', () => {
    for (const status of ['fired', 'cancelled'] as const) {
      const out = evaluatePriceAlert({ ...base, status }, { kind: 'ok', price: '999', at: new Date() });
      expect(out).toMatchObject({ kind: 'refuse', code: 'alert.not_active' });
    }
  });

  it('refuses a garbage mark string instead of inventing a fire', () => {
    const out = evaluatePriceAlert(base, { kind: 'ok', price: 'n/a', at: new Date() });
    expect(out.kind).toBe('refuse');
    if (out.kind === 'refuse') expect(out.code).toBe('alert.price_unavailable');
  });
});

function assertNoNumberMoney(value: unknown): void {
  if (typeof value === 'number') {
    throw new Error(`invented number money: ${value}`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoNumberMoney(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (/balance|amount|equity|pnl|total|markPrice|targetPrice/i.test(key) && typeof nested === 'number') {
        throw new Error(`invented number money at ${key}: ${nested}`);
      }
      assertNoNumberMoney(nested);
    }
  }
}

describe('evaluatePortfolioAlert — refuse-closed, no invented book', () => {
  it('refuses with a stable unpublished code and never fires', () => {
    const out = evaluatePortfolioAlert();
    expect(out).toEqual({
      kind: 'refuse',
      code: ALERT_PORTFOLIO_VIEW_UNPUBLISHED,
      detail: 'ledger portfolio view unpublished — notify holds no balance',
    });
    expect(out.kind).not.toBe('fire');
    expect(out.kind).not.toBe('hold');
    assertNoNumberMoney(out);
    expect('markPrice' in out).toBe(false);
  });

  it('silence is not a fire — no quote, no balance, still refuse', () => {
    const out = evaluatePortfolioAlert();
    expect(out.kind).toBe('refuse');
    if (out.kind === 'refuse') {
      expect(out.code).toBe('alert.portfolio_view_unpublished');
    }
    assertNoNumberMoney(out);
  });
});

describe('evaluateUnpublishedKind — never fire on an invented series', () => {
  it.each([...UNPUBLISHED_ALERT_KINDS])('%s refuses alert.kind_unpublished and never fires', (kind) => {
    const out = evaluateUnpublishedKind(kind);
    expect(out).toEqual({
      kind: 'refuse',
      code: ALERT_KIND_UNPUBLISHED,
      detail: `${kind} has no sourced series`,
    });
    expect(out.kind).not.toBe('fire');
    expect(out.kind).not.toBe('hold');
    expect('markPrice' in out).toBe(false);
  });

  it('intelligence stays unpublished — whale / funding / liq do not', () => {
    expect(UNPUBLISHED_ALERT_KINDS).toEqual(['intelligence']);
    expect(UNPUBLISHED_ALERT_KINDS).not.toContain('whale');
    expect(UNPUBLISHED_ALERT_KINDS).not.toContain('funding');
    expect(UNPUBLISHED_ALERT_KINDS).not.toContain('liquidation_proximity');
  });
});

describe('evaluateWhaleAlert — refuse alerts.whale_mark_dark, never invent flow', () => {
  const whale: PriceAlert = { ...base, kind: 'whale', targetPrice: '1000' };

  it('refuses a dark flow mark and never fires', () => {
    const out = evaluateWhaleAlert(whale, { kind: 'unavailable', reason: 'dark' });
    expect(out).toEqual({
      kind: 'refuse',
      code: ALERTS_WHALE_MARK_DARK,
      detail: 'dark',
    });
    expect(out.kind).not.toBe('fire');
    expect('markPrice' in out).toBe(false);
  });

  it('refuses a garbage flow string instead of inventing a number', () => {
    const out = evaluateWhaleAlert(whale, { kind: 'ok', price: 'n/a', at: new Date() });
    expect(out).toEqual({
      kind: 'refuse',
      code: ALERTS_WHALE_MARK_DARK,
      detail: 'flow not a positive decimal: n/a',
    });
    expect(out.kind).not.toBe('fire');
  });

  it('fires when sourced flow is at or above target; holds below', () => {
    expect(evaluateWhaleAlert(whale, { kind: 'ok', price: '1000', at: new Date() })).toEqual({
      kind: 'fire',
      markPrice: '1000',
    });
    expect(evaluateWhaleAlert(whale, { kind: 'ok', price: '999', at: new Date() })).toEqual({
      kind: 'hold',
      markPrice: '999',
    });
    assertNoNumberMoney(evaluateWhaleAlert(whale, { kind: 'ok', price: '1000', at: new Date() }));
  });

  it('a live price print is not a whale fire — evaluateWhaleAlert still needs a flow quote', () => {
    const priceFire = evaluatePriceAlert(base, { kind: 'ok', price: '100.5', at: new Date() });
    expect(priceFire.kind).toBe('fire');
    const darkFlow = evaluateWhaleAlert(whale, { kind: 'unavailable', reason: 'dark', detail: 'not a price' });
    expect(darkFlow).toMatchObject({ kind: 'refuse', code: ALERTS_WHALE_MARK_DARK });
  });
});

describe('evaluatePriceAlert — funding and liquidation_proximity use the sourced mark', () => {
  it.each(['funding', 'liquidation_proximity'] as const)('%s fires on a live cross and refuses a dark mark', (kind) => {
    const watch: PriceAlert = { ...base, kind };
    const fire = evaluatePriceAlert(watch, { kind: 'ok', price: '100.5', at: new Date() });
    expect(fire).toEqual({ kind: 'fire', markPrice: '100.5' });
    const dark = evaluatePriceAlert(watch, { kind: 'unavailable', reason: 'dark' });
    expect(dark).toEqual({ kind: 'refuse', code: 'alert.price_unavailable', detail: 'dark' });
    expect(dark.kind).not.toBe('fire');
  });
});
