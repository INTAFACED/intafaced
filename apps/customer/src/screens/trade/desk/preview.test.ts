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
  it('explains an unavailable order book without showing service text or its market ID', () => {
    const failure = failureOf(
      {
        ok: false,
        reason: 'error',
        code: 'trade.matching_market_missing',
        message: 'matching holds no book for 00000000-0000-4000-8000-000000000001',
      },
      {},
    );
    expect(failure).toMatchObject({
      kind: 'refusal',
      copy: {
        title: 'No one is trading this market right now',
        body: 'Prices will show when the first orders arrive.',
      },
    });
    expect(JSON.stringify(failure)).not.toContain('00000000');
  });

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

  it('a frozen ledger, which the service reports as a generic exchange error with the useful code only in its message, reads as paused orders', () => {
    const failure = failureOf({ ok: false, reason: 'error', message: 'ledger.frozen', code: 'ExchangeError', status: 400 }, {});
    expect(failure).toMatchObject({ kind: 'refusal', copy: { title: 'Orders are paused right now' } });
    expect(JSON.stringify(failure)).not.toMatch(/ledger|LedgerError/i);
    // Any other LedgerError stays the generic refusal.
    expect(failureOf({ ok: false, reason: 'error', message: 'ledger.other', code: 'ExchangeError', status: 400 }, {})).toMatchObject({
      copy: { title: "This can't be done right now" },
    });
  });
});
