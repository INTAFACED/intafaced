import { describe, expect, it } from 'vitest';
import type { Preview } from '../../../features/trade/trade-api';
import { failureOf, previewIsOrderable, previewRefusalCode, refusalFailure } from './preview';

const preview = (extra: Partial<Preview> = {}): Preview => ({
  symbol: 'BTC/USDT',
  side: 'buy',
  type: 'limit',
  amount: '0.0001',
  price: '64000',
  timeInForce: 'GTC',
  holdAsset: 'USDT',
  holdAmount: '6.4064',
  protectionPrice: null,
  estimatedFee: '0.0064',
  feeAsset: 'USDT',
  feeBps: 10,
  feeRole: 'maker',
  orderable: true,
  refusals: [],
  ...extra,
});

describe('previewIsOrderable', () => {
  it('needs orderable, no refusals, and a known hold and fee', () => {
    expect(previewIsOrderable(preview())).toBe(true);
    expect(previewIsOrderable(preview({ orderable: false }))).toBe(false);
    expect(previewIsOrderable(preview({ refusals: [{ code: 'x', field: 'order', message: 'no' }] }))).toBe(false);
    expect(previewIsOrderable(preview({ holdAmount: null }))).toBe(false);
    expect(previewIsOrderable(preview({ holdAsset: null }))).toBe(false);
    expect(previewIsOrderable(preview({ estimatedFee: null }))).toBe(false);
    expect(previewIsOrderable(preview({ feeAsset: null }))).toBe(false);
    expect(previewIsOrderable(preview({ holdAmount: '0' }))).toBe(false);
  });

  it('reads the first refusal code', () => {
    expect(previewRefusalCode(preview({ refusals: [{ code: 'tier.insufficient', field: 'order', message: 'm' }] }))).toBe(
      'tier.insufficient',
    );
    expect(previewRefusalCode(preview())).toBeNull();
  });
});

describe('refusal words', () => {
  it('an unverified account gets the Verify path and a support reference, never the raw code', () => {
    const failure = refusalFailure('tier.insufficient', {});
    expect(failure).toMatchObject({ kind: 'refusal', copy: { title: 'Verify your identity first', action: { href: '/verification' } } });
    expect(JSON.stringify(failure)).not.toContain('tier.insufficient');
  });

  it('not enough funds names the asset and what is available', () => {
    const failure = refusalFailure('ledger.insufficient_funds', { asset: 'USDT', available: '4,100' });
    expect(failure).toMatchObject({ kind: 'refusal', copy: { title: 'Not enough USDT', body: 'You have 4,100 USDT available.' } });
  });

  it('a call that failed is a refusal when it has a code or a 401, and unknown otherwise', () => {
    expect(failureOf({ ok: false, reason: 'error', message: 'm', code: 'trade.slippage_cap_unset', status: 400 }, {})).toMatchObject({
      kind: 'refusal',
      copy: { title: 'Market orders are paused' },
    });
    expect(failureOf({ ok: false, reason: 'unauthorized', message: 'm', status: 401 }, {})).toMatchObject({
      kind: 'refusal',
      copy: { title: 'Sign in again' },
    });
    expect(failureOf({ ok: false, reason: 'unreachable', message: 'm' }, {})).toEqual({ kind: 'network' });
  });
});
