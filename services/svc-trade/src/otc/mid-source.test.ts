import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createConfigOtcMidSource, createObservedOtcMidSource, NO_OTC_MIDS, otcPairKey, parseOtcMids } from './mid-source.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('otc mid-source', () => {
  it('pair key is upper-cased BASE/QUOTE, matching trade.markets.symbol', () => {
    expect(otcPairKey('btc', 'usdt')).toBe('BTC/USDT');
    expect(otcPairKey(' eth ', ' usd ')).toBe('ETH/USD');
  });

  it('an asset containing the separator is refused, not normalised', () => {
    // Otherwise ('BTC','USDT/X') and ('BTC/USDT','X') collide on one mid.
    expect(otcPairKey('BTC', 'USDT/X')).toBeNull();
    expect(otcPairKey('BTC/USDT', 'X')).toBeNull();
    expect(otcPairKey('', 'USDT')).toBeNull();
    expect(otcPairKey('BTC', '   ')).toBeNull();
  });

  it('drops a pair side that is not exactly two segments so it cannot overwrite a real mid', () => {
    // BTC/USDT/X must not land on BTC/USDT. An absent pair stays absent.
    expect(parseOtcMids('BTC/USDT/X:1').size).toBe(0);
    expect(parseOtcMids('BTC/USDT:65000,BTC/USDT/X:1').get('BTC/USDT')).toBe('65000');
    expect(parseOtcMids('BTC/USDT:1.50').get('BTC/USDT')).toBe('1.50');
  });

  it('drops an ops entry whose price is not a positive decimal', async () => {
    // An ops typo must cost a refusal at boot, not surface to a customer.
    const src = createConfigOtcMidSource('BTC/USDT:not-a-number,ETH/USDT:0,SOL/USDT:-5,XRP/USDT:1e5,ADA/USDT:1.1234567890123456789');
    expect(await src('BTC/USDT')).toBeNull();
    expect(await src('ETH/USDT')).toBeNull();
    expect(await src('SOL/USDT')).toBeNull();
    expect(await src('XRP/USDT')).toBeNull();
    expect(await src('ADA/USDT')).toBeNull();
  });

  it('keeps a past-MAX_SAFE_INTEGER mid as the decimal string — never Number()', async () => {
    const pastSafe = '9007199254740993';
    expect(String(Number(pastSafe))).not.toBe(pastSafe);
    const src = createConfigOtcMidSource(`BTC/USDT:${pastSafe}`);
    expect(await src('BTC/USDT')).toMatchObject({ mid: pastSafe });
    expect(parseOtcMids(`BTC/USDT:${pastSafe}`).get('BTC/USDT')).toBe(pastSafe);
  });

  it('parses mids via parseAmount — never Number() on the money string', () => {
    const src = readFileSync(join(here, 'mid-source.ts'), 'utf8');
    expect(src).toMatch(/parseAmount/);
    expect(src).not.toMatch(/\bNumber\s*\(/);
    expect(src).not.toMatch(/\bparseFloat\s*\(/);
  });

  it('the production default sources nothing', async () => {
    expect(await NO_OTC_MIDS('BTC/USDT')).toBeNull();
  });

  it('blank env sources nothing — no zero, no invent', async () => {
    const src = createConfigOtcMidSource('');
    expect(await src('BTC/USDT')).toBeNull();
    expect(await createConfigOtcMidSource(undefined)('BTC/USDT')).toBeNull();
  });

  it('reads an ops-published mid stamped at boot asOf', async () => {
    const boot = new Date('2026-08-07T12:00:00.000Z');
    const src = createConfigOtcMidSource('BTC/USDT:65000,ETH/USDT:3200', boot);
    expect(await src('BTC/USDT')).toEqual({ mid: '65000', asOf: boot });
    expect(await src('ETH/USDT')).toEqual({ mid: '3200', asOf: boot });
    expect(await src('SOL/USDT')).toBeNull();
  });

  it('observed source refreshes asOf from the feed clock', async () => {
    let t = new Date('2026-08-07T12:00:00.000Z');
    const src = createObservedOtcMidSource('BTC/USDT:200', () => t);
    expect(await src('BTC/USDT')).toEqual({ mid: '200', asOf: t });
    t = new Date('2026-08-07T12:01:00.000Z');
    expect(await src('BTC/USDT')).toEqual({ mid: '200', asOf: t });
  });
});
