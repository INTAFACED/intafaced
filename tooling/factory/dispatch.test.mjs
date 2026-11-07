// The builder dispatcher (dispatch.mjs): one `gh workflow run builder.yml` per journey, every journey checked before any
// starts, and a 403 or 429 stops the batch. tooling-tests.mjs runs this file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dispatch, ghArgs, isRefusal, parseArgs, plan } from './dispatch.mjs';

const CATALOG = [
  { id: 'J-identity-13', module: 'identity' },
  { id: 'J-identity-14', module: 'identity' },
  { id: 'J-wallet-05', module: 'wallet' },
  { id: 'J-academy-04', module: 'academy', parked: true },
];

test('the command line: journeys, per-journey areas, --area, --dry-run', () => {
  const a = parseArgs(['--area', 'trader', 'J-identity-13,J-wallet-05=wallet', 'J-identity-14', '--dry-run']);
  assert.equal(a.area, 'trader');
  assert.equal(a.dryRun, true);
  assert.deepEqual(a.journeys, [{ journey: 'J-identity-13' }, { journey: 'J-wallet-05', area: 'wallet' }, { journey: 'J-identity-14' }]);
  assert.match(parseArgs([]).error, /at least one journey/);
  assert.match(parseArgs(['--area']).error, /needs a value/);
  assert.match(parseArgs(['--fast', 'J-identity-13']).error, /unknown option/);
});

test("a journey's area: its own, then --area, then its module", () => {
  const { runs } = plan(parseArgs(['J-identity-13', 'J-wallet-05=payments']), CATALOG);
  assert.deepEqual(runs, [
    { journey: 'J-identity-13', area: 'identity' },
    { journey: 'J-wallet-05', area: 'payments' },
  ]);
  assert.deepEqual(plan(parseArgs(['--area', 'x', 'J-identity-13']), CATALOG).runs, [{ journey: 'J-identity-13', area: 'x' }]);
});

test('one bad journey starts none', () => {
  for (const [argv, why] of [
    [['J-identity-13', 'J-academy-04'], /parked/],
    [['J-identity-13', 'J-nope-01'], /not in docs/],
    [['J-identity-13', 'J-identity-13'], /named twice/],
    [['J-identity-13;rm -rf'], /not a journey id/],
    [['J-identity-13=Bad Area'], /area/],
  ]) {
    const p = plan(parseArgs(argv), CATALOG);
    assert.match(p.error ?? '', why, argv.join(' '));
    assert.equal(p.runs, undefined);
  }
});

test('each journey is one gh workflow run of builder.yml on main, arguments never through a shell', () => {
  assert.deepEqual(ghArgs({ journey: 'J-identity-13', area: 'identity' }), [
    'workflow',
    'run',
    'builder.yml',
    '-R',
    'INTAFACED/intafaced',
    '--ref',
    'main',
    '-f',
    'journey=J-identity-13',
    '-f',
    'area=identity',
  ]);
  const calls = [];
  const r = dispatch(
    [
      { journey: 'J-identity-13', area: 'identity' },
      { journey: 'J-wallet-05', area: 'wallet' },
    ],
    { exec: (cmd, args) => calls.push([cmd, ...args]), log: () => {} },
  );
  assert.deepEqual(r, { started: ['J-identity-13', 'J-wallet-05'], failed: [], stopped: null });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c[0] === 'gh' && c[3] === 'builder.yml'));
});

test('a 403 or 429 stops the batch; any other failure is reported and the rest go on', () => {
  const runs = ['J-identity-13', 'J-identity-14', 'J-wallet-05'].map((journey) => ({ journey, area: 'a' }));
  const fail = (stderr) => {
    const e = new Error('Command failed');
    e.stderr = stderr;
    throw e;
  };
  let n = 0;
  const stopped = dispatch(runs, { exec: () => (++n === 2 ? fail('HTTP 429: API rate limit exceeded') : null), log: () => {} });
  assert.deepEqual(stopped.started, ['J-identity-13']);
  assert.match(stopped.stopped, /J-identity-14: GitHub refused/);
  assert.equal(n, 2, 'nothing after the refusal is tried');
  n = 0;
  const failed = dispatch(runs, { exec: () => (++n === 2 ? fail('could not find workflow') : null), log: () => {} });
  assert.deepEqual(failed, { started: ['J-identity-13', 'J-wallet-05'], failed: ['J-identity-14'], stopped: null });
  assert.equal(isRefusal('HTTP 403: Resource not accessible'), true);
  assert.equal(isRefusal('You have exceeded a secondary rate limit'), true);
  assert.equal(isRefusal('HTTP 404: Not Found'), false);
});

test('--dry-run against the real journeys.json prints the commands and starts nothing', () => {
  const script = fileURLToPath(new URL('./dispatch.mjs', import.meta.url));
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const out = execFileSync(process.execPath, [script, '--dry-run', 'J-identity-13'], { cwd: root, encoding: 'utf8' });
  assert.equal(out, 'gh workflow run builder.yml -R INTAFACED/intafaced --ref main -f journey=J-identity-13 -f area=identity\n');
});
