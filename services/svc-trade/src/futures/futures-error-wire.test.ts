/**
 * Unit card — unnamed profit pot is NotSupported, not a 5xx retry
 * 1. Promise: REST FuturesError for unconfigured pot tells bots retry:false
 * 2. Break: body is only { error, message } so CCXT retries 503 as venue-down
 * 3. Done bar: presentFuturesErrorWire + private-rest uses it
 * 4. Class N
 * 5. Paths: futures-error-wire.ts, private-rest.ts
 */

import { describe, expect, it } from 'vitest';
import { presentFuturesErrorWire } from './futures-error-wire.js';

describe('presentFuturesErrorWire', () => {
  it('unnamed pot on open is NotSupported and not retryable', () => {
    const body = presentFuturesErrorWire({
      code: 'trade.futures_unconfigured',
      message: 'no pot',
    });
    expect(body).toEqual({
      error: 'trade.futures_unconfigured',
      message: 'no pot',
      ccxtCode: 'NotSupported',
      retry: false,
    });
  });

  it('unnamed pot on winning close is the same class', () => {
    const body = presentFuturesErrorWire({
      code: 'trade.profit_source_unconfigured',
      message: 'cannot pay',
    });
    expect(body.retry).toBe(false);
    expect(body.ccxtCode).toBe('NotSupported');
  });

  it('does not invent a retry class for mark refusal', () => {
    const body = presentFuturesErrorWire({
      code: 'trade.mark_unusable',
      message: 'dark',
    });
    expect(body).toEqual({ error: 'trade.mark_unusable', message: 'dark' });
    expect(body).not.toHaveProperty('retry');
  });
});
