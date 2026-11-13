// HISTORY_SYMBOLS, the markets `local-test-market.mjs history` writes past trades on, must hold every spot market whose
// past a journey reads. (Failure it prevents: a journey that charts a market history leaves out would read an empty
// chart and fail on the stack, not on the app.)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SYMBOLS, HISTORY_SYMBOLS } from './local-test-market.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const JOURNEYS = join(ROOT, 'apps/customer/tests/real-app');

/** A journey source reads a market's past when it reads charts, candles or the public tape. */
const READS_PAST = /candle|ohlcv|kline|chart|tape|\/trades\//i;

/** The default spot markets a journey source names, when that source reads a market's past. */
export function pastMarketsRead(src, symbols = DEFAULT_SYMBOLS) {
  if (!READS_PAST.test(src)) return [];
  const spot = symbols.filter((s) => !s.includes(':'));
  return spot.filter((s) => new RegExp(`(^|[^A-Z/])${s.replace('/', '\\/')}(?![A-Z:/])`).test(src));
}

/** The markets journey files read the past of and history leaves out, as "file: market". */
export function historySymbolsJourneysRead(files, history = HISTORY_SYMBOLS) {
  const missing = [];
  for (const [file, src] of files) for (const s of pastMarketsRead(src)) if (!history.includes(s)) missing.push(`${file}: ${s}`);
  return missing;
}

test('every spot market a journey reads the past of gets history', () => {
  const files = readdirSync(JOURNEYS)
    .filter((f) => f.endsWith('.pw.mjs'))
    .map((f) => [f, readFileSync(join(JOURNEYS, f), 'utf8')]);
  assert.ok(files.length > 100, `read ${files.length} journey files`);
  assert.ok(
    files.some(([, src]) => pastMarketsRead(src).includes('BTC/USDT')),
    'some journey charts BTC/USDT',
  );
  assert.deepEqual(historySymbolsJourneysRead(files), []);
});

test('history markets are default spot markets', () => {
  for (const s of HISTORY_SYMBOLS) {
    assert.ok(DEFAULT_SYMBOLS.includes(s), `${s} is a default market`);
    assert.ok(!s.includes(':'), `${s} is spot`);
  }
});

test('a journey charting a market history leaves out is named (planted fault)', () => {
  const planted = [['J-planted.pw.mjs', "await page.goto('/charts'); const c = await candles('ETH/BTC', '15m');"]];
  assert.deepEqual(historySymbolsJourneysRead(planted), ['J-planted.pw.mjs: ETH/BTC']);
  assert.deepEqual(historySymbolsJourneysRead([['J-trades-only.pw.mjs', "await buy('ETH/BTC');"]]), [], 'trading a market reads no past');
  assert.deepEqual(pastMarketsRead("chart of 'BTC/USDT:USDT'"), [], 'the perpetual is not the spot market');
});
