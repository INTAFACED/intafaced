import { describe, expect, it } from 'vitest';
import type { Preview } from '../../../features/trade/trade-api';
import {
  asReplacement,
  failureOf,
  previewFailure,
  previewIsOrderable,
  previewRefusalCode,
  refusalFailure,
  isLedgerFrozen,
} from './preview';

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

describe('asReplacement', () => {
  const cap = { code: 'trade.operator_throttle', field: 'symbol', message: 'm', data: { cap: '20', open: '20' } };
  const band = { code: 'trade.price_band', field: 'price', message: 'm' };
  it('an edit is never refused by an open-order cap: the replacement takes the slot its original frees', () => {
    expect(previewIsOrderable(asReplacement(preview({ orderable: false, refusals: [cap] })))).toBe(true);
    expect(
      previewIsOrderable(asReplacement(preview({ orderable: false, refusals: [{ ...cap, code: 'trade.limit_max_open_orders' }] }))),
    ).toBe(true);
    expect(
      previewIsOrderable(asReplacement(preview({ orderable: false, refusals: [{ ...cap, code: 'trade.open_orders_cap_unset' }] }))),
    ).toBe(true);
  });
  it('every other refusal stays', () => {
    expect(previewIsOrderable(asReplacement(preview({ orderable: false, refusals: [cap, band] })))).toBe(false);
    expect(asReplacement(preview({ orderable: false, refusals: [band] })).refusals).toEqual([band]);
  });
});

describe('previewFailure', () => {
  it('names the band edges at the tick and the cap with the count', () => {
    const band = { code: 'trade.price_band', field: 'price', message: 'm', data: { low: '58500', high: '71500', collar: '0.1' } };
    const failure = previewFailure(preview({ orderable: false, refusals: [band] }), {}, '0.01');
    expect(failure.kind === 'refusal' && failure.copy.body).toContain('buy prices up to 71,500.00 and sell prices down to 58,500.00');
    const cap = { code: 'trade.operator_throttle', field: 'symbol', message: 'm', data: { cap: '20', open: '20' } };
    const full = previewFailure(preview({ orderable: false, refusals: [cap] }), {});
    expect(full.kind === 'refusal' && full.copy.body).toBe(
      'You have 20 open orders here and this market allows 20. Cancel one to place another.',
    );
  });
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
    // The trade API's own code for the platform posting freeze, on its 503 (a POST 5xx reads as uncertain), is paused too.
    const posting = {
      ok: false as const,
      reason: 'uncertain' as const,
      message: 'Ledger posting is frozen',
      code: 'posting_frozen',
      status: 503,
    };
    expect(isLedgerFrozen(posting)).toBe(true);
    expect(failureOf(posting, {})).toMatchObject({ kind: 'refusal', copy: { title: 'Orders are paused right now' } });
    expect(isLedgerFrozen({ message: 'Ledger posting is frozen', code: 'ExchangeError' })).toBe(false);
    // Any other LedgerError stays the generic refusal.
    expect(failureOf({ ok: false, reason: 'error', message: 'ledger.other', code: 'ExchangeError', status: 400 }, {})).toMatchObject({
      copy: { title: "This can't be done right now" },
    });
  });
});
