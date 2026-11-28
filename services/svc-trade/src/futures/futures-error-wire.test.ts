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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  const privateRestSource = readFileSync(join(here, '..', 'private-rest.ts'), 'utf8');

  it('private-rest sends FuturesError through presentFuturesErrorWire (kept source pin)', () => {
    expect(privateRestSource).toContain('presentFuturesErrorWire');
  });
});
