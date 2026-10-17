import { describe, expect, it } from 'vitest';
import { bpsToPercent, feeCellFor, feeCellSortValue, feeCellText, parseEffectiveFees } from './fees-model';
import { ok, refused, unknown } from './outcome';

const body = {
  source: 'TRADE_FEE_SCHEDULE',
  version: 'desk',
  markets: [
    {
      symbol: 'BTC/USDT',
      kind: 'spot',
      product: 'spot',
      charged: { makerBps: '8', takerBps: '10', makerRate: '0.0008', takerRate: '0.001' },
      refusal: null,
    },
    { symbol: 'BTC-OPT', kind: 'options', product: null, charged: null, refusal: 'trade.fee_product_unpublished' },
  ],
};

describe('parseEffectiveFees', () => {
  it('keeps bps and rates as the exact strings the service sent', () => {
    const fees = parseEffectiveFees(body);
    expect(fees?.markets[0]?.charged).toEqual({ makerBps: '8', takerBps: '10', makerRate: '0.0008', takerRate: '0.001' });
    expect(fees?.version).toBe('desk');
  });

  it('refuses a body that sends bps as a JSON number, a row with neither charge nor refusal, or both', () => {
    const num = {
      ...body,
      markets: [{ ...body.markets[0], charged: { makerBps: 8, takerBps: '10', makerRate: '0.0008', takerRate: '0.001' } }],
    };
    expect(parseEffectiveFees(num)).toBeNull();
    expect(parseEffectiveFees({ ...body, markets: [{ ...body.markets[1], refusal: null }] })).toBeNull();
    expect(parseEffectiveFees({ ...body, markets: [{ ...body.markets[0], refusal: 'x' }] })).toBeNull();
    expect(parseEffectiveFees({ ...body, markets: 'nope' })).toBeNull();
  });
});

describe('bpsToPercent', () => {
  it('is exact integer maths: 8 → 0.08%, 10 → 0.10%, 125 → 1.25%, 0 → 0.00%', () => {
    expect(bpsToPercent('8')).toBe('0.08%');
    expect(bpsToPercent('10')).toBe('0.10%');
    expect(bpsToPercent('125')).toBe('1.25%');
    expect(bpsToPercent('0')).toBe('0.00%');
    expect(bpsToPercent('9999')).toBe('99.99%');
  });
});

describe('feeCellFor', () => {
  const read = ok(parseEffectiveFees(body)!);

  it('shows the charged schedule, not any listing number', () => {
    const cell = feeCellFor(read, 'BTC/USDT');
    expect(feeCellText(cell)).toBe('0.08% / 0.10%');
    expect(feeCellSortValue(cell)).toBe('8');
  });

  it('shows a product the schedule does not publish as a refusal with the service code', () => {
    expect(feeCellText(feeCellFor(read, 'BTC-OPT'))).toBe('Refused (trade.fee_product_unpublished)');
  });

  it('refuses every cell with the service code when the whole schedule is blank', () => {
    const blank = refused('trade.fee_schedule_blank', 'Trading fees are not available yet.', 503);
    expect(feeCellFor(blank, 'BTC/USDT')).toEqual({ kind: 'refused', code: 'trade.fee_schedule_blank' });
    expect(feeCellText(feeCellFor(blank, 'BTC/USDT'))).toBe('Refused (trade.fee_schedule_blank)');
    expect(feeCellSortValue(feeCellFor(blank, 'BTC/USDT'))).toBeNull();
  });

  it('shows a dash, never zero, when the read did not complete or has no row for the market', () => {
    expect(feeCellText(feeCellFor(unknown('timeout'), 'BTC/USDT'))).toBe('—');
    expect(feeCellText(feeCellFor(read, 'ETH/USDT'))).toBe('—');
  });
});
