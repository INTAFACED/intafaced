// journey-market-past.mjs decides whether a journeys shard, a full run's or a targeted one's, skips the TEST chart history. It may say `none` only
// when no named file, and no helper it imports, reads a market's past. (Failure it prevents: a chart journey run by
// hand on a stack with no history, which would fail on the stack and not on the app.)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JOURNEYS_DIR, historyFor, historyForShard, pastReads, withoutComments } from './journey-market-past.mjs';
import { JOURNEY_DIR, MAX_SHARDS, freshFiles, journeyFiles, planShards } from './journey-shards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

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

// project-state#3329 (19 Nov 2026): full runs of 90 shards held all 500 of GitHub's hosted runners (run 44514711810: 78
// shards waiting), and every full-run shard wrote the history, because the market step asked only on a targeted run.
test("a full run's shard plan: a shard whose files read no past gets no history, any doubt gets it", () => {
  const f = folder({
    'J-bank-01.pw.mjs': "import { fund } from './stack.mjs';\nfund();",
    'J-bank-02.pw.mjs': 'ok',
    'J-charts-desk-01.pw.mjs': "await page.goto('/charts/btc-usdt');",
    'stack.mjs': "export const fund = () => fetch('http://127.0.0.1/ledger');",
  });
  const plan = JSON.stringify(['J-bank-01.pw.mjs J-bank-02.pw.mjs', 'J-bank-02.pw.mjs J-charts-desk-01.pw.mjs', 'J-gone.pw.mjs', '']);
  assert.equal(historyForShard(plan, 1, f).history, 'none');
  assert.equal(historyForShard(plan, 2, f).history, 'journeys', 'one reader writes it for the shard');
  assert.equal(historyForShard(plan, 3, f).history, 'journeys', "a file that can't be read");
  assert.equal(historyForShard(plan, 4, f).history, 'journeys', 'an empty shard');
  assert.equal(historyForShard(plan, 5, f).history, 'journeys', 'a shard the plan lacks');
  assert.equal(historyForShard(plan, 0, f).history, 'journeys');
  assert.equal(historyForShard(plan, Number.NaN, f).history, 'journeys');
  assert.equal(historyForShard('', 1, f).history, 'journeys', 'no plan');
  assert.equal(historyForShard('{"1":"J-bank-02.pw.mjs"}', 1, f).history, 'journeys', 'a plan that is not a list');
  assert.equal(historyForShard('[1]', 1, f).history, 'journeys', 'a shard that is not a string');
});

test('on the real journeys, a full plan of MAX_SHARDS: the chart desks keep the history, and many shards skip it', () => {
  const files = journeyFiles(join(ROOT, JOURNEY_DIR));
  const plan = planShards(files, new Map(files.map((x) => [x, 1])), MAX_SHARDS, freshFiles(join(ROOT, JOURNEY_DIR), files));
  const json = JSON.stringify(plan.map((bin) => bin.files.join(' ')));
  const verdicts = plan.map((_, i) => historyForShard(json, i + 1).history);
  plan.forEach((bin, i) => {
    if (bin.files.some((x) => x.startsWith('J-charts-desk-'))) assert.equal(verdicts[i], 'journeys', `shard ${i + 1}`);
  });
  const none = verdicts.filter((v) => v === 'none').length;
  assert.ok(none >= MAX_SHARDS / 5, `${none} of ${MAX_SHARDS} shards skip the history`);
});

test("the market step asks on every planned shard, a full run's too, and writes the history on any doubt", () => {
  // The step runs the shard's one setup (tooling/ci/journey-shard.sh markets), with the plan, on every planned shard.
  const wf = readFileSync(join(ROOT, '.github/workflows/real-app-journeys.yml'), 'utf8');
  const wfStep = wf.slice(
    wf.indexOf('- name: Open the TEST markets, write TEST chart history'),
    wf.indexOf('- name: Load the TEST content'),
  );
  assert.match(wfStep, /SHARDS: \$\{\{ needs\.touch\.outputs\.shards \}\}\n\s+SHARD: \$\{\{ matrix\.shard \}\}/);
  assert.match(wfStep, /run: bash tooling\/ci\/journey-shard\.sh markets\n/);
  const sh = readFileSync(join(ROOT, 'tooling/ci/journey-shard.sh'), 'utf8');
  const step = sh.slice(sh.indexOf('  markets)\n'), sh.indexOf('  content)\n'));
  assert.ok(step.length > 0, 'the market step is in the shard setup');
  assert.match(
    step,
    /if \[ -n "\$\{SHARDS:-\}" \]; then\n\s+history=\$\(node tooling\/scripts\/journey-market-past\.mjs --shard "\$SHARD"\) \|\| history=journeys\n\s+fi/,
  );
  assert.doesNotMatch(step, /JOURNEYS_TARGET/, 'a full run has no target, and must still ask');
  assert.match(step, /^\s+history=journeys$/m, 'a run without a plan writes it');
  assert.match(step, /if \[ "\$history" = none \]; then/, 'only an exact `none` skips it');
});
