// journey-market-past.mjs decides whether a targeted journeys shard skips the TEST chart history. It may say `none` only
// when no named file, and no helper it imports, reads a market's past. (Failure it prevents: a chart journey run by
// hand on a stack with no history, which would fail on the stack and not on the app.)
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { JOURNEYS_DIR, historyFor, pastReads, withoutComments } from './journey-market-past.mjs';

/** A journeys folder in memory: name -> source. */
function folder(files) {
  const dir = '/j';
  const map = new Map(Object.entries(files).map(([k, v]) => [join(dir, k), v]));
  return { dir, read: (p) => map.get(p), exists: (p) => map.has(p) };
}

test('a journey with no market words, through its helpers, needs no history', () => {
  const f = folder({
    'J-bank-01.pw.mjs': "import { test } from './journey.mjs';\nimport { fund } from './stack.mjs';\ntest('#1 deposit', () => fund());",
    'journey.mjs': "// the chart of steps (a comment reads nothing)\nexport const test = 1; import './world.mjs';",
    'stack.mjs': "export const fund = () => fetch('http://127.0.0.1/ledger');",
    'world.mjs': '/* new candles */ export const w = 1;',
  });
  assert.deepEqual(pastReads('J-bank-01.pw.mjs', f), []);
  assert.equal(historyFor(['J-bank-01.pw.mjs'], f).history, 'none');
});

test('a journey that reads a chart, in its own source or a helper, needs the history (planted faults)', () => {
  const f = folder({
    'J-own.pw.mjs': "await page.goto('/charts/btc-usdt');",
    'J-helper.pw.mjs': "import { look } from './desk.mjs';\nawait look(page);",
    'J-deep.pw.mjs': "import { a } from './a.mjs';",
    'J-dynamic.pw.mjs': "const { tape } = await import('./tape.mjs');",
    'J-comment.pw.mjs': '// step 2 reads the candles\nawait page.click("#go");',
    'J-market.pw.mjs': "import { HISTORY_SYMBOLS } from '../../../../tooling/scripts/local-test-market.mjs';",
    'J-missing.pw.mjs': "import { x } from './gone.mjs';",
    'desk.mjs': "export const look = (p) => p.getByTestId('candle-row');",
    'a.mjs': "export { b } from './b.mjs';",
    'b.mjs': "export const b = () => api('/v1/market/kline');",
    'tape.mjs': "export const tape = () => api('/v1/trades/BTC-USDT');",
  });
  for (const name of ['J-own', 'J-helper', 'J-deep', 'J-dynamic', 'J-comment', 'J-market', 'J-missing']) {
    assert.ok(pastReads(`${name}.pw.mjs`, f).length > 0, `${name} reads the past`);
    assert.equal(historyFor([`${name}.pw.mjs`], f).history, 'journeys', name);
  }
});

test('one reader in a shard writes the history for all of it', () => {
  const f = folder({ 'J-a.pw.mjs': 'ok', 'J-b.pw.mjs': "getByRole('img', { name: 'chart' })" });
  assert.equal(historyFor(['J-a.pw.mjs'], f).history, 'none');
  assert.equal(historyFor(['J-a.pw.mjs', 'J-b.pw.mjs'], f).history, 'journeys');
});

test('no files, or a name that is not a journey file, writes the history', () => {
  const f = folder({ 'J-a.pw.mjs': 'ok' });
  assert.equal(historyFor([], f).history, 'journeys');
  assert.equal(historyFor([''], f).history, 'journeys');
  assert.equal(historyFor(['../J-a.pw.mjs'], f).history, 'journeys');
  assert.equal(historyFor(['J-a.pw.mjs', 'stack.mjs'], f).history, 'journeys');
});

test("comments go, a URL's // stays", () => {
  assert.equal(withoutComments("a('http://x/chart') // chart").trim(), "a('http://x/chart')");
  assert.equal(withoutComments('/* chart */x').trim(), 'x');
});

test('on the real journeys: the chart desks read the past, and some journeys read none', () => {
  const files = readdirSync(JOURNEYS_DIR).filter((f) => f.endsWith('.pw.mjs'));
  assert.ok(files.length > 100, `read ${files.length} journey files`);
  const charts = files.filter((f) => f.startsWith('J-charts-desk-'));
  assert.ok(charts.length > 0, 'there are chart desk journeys');
  for (const f of charts) assert.equal(historyFor([f]).history, 'journeys', f);
  assert.ok(
    files.some((f) => historyFor([f]).history === 'none'),
    'some journey reads no market past',
  );
});
