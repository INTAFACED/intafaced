// garden/no-hand-clock on planted files, each a past mistake as it was written: it fires on J-portfolio-04 #3 before its
// fix (#7871: a candle read at two clock reads while their minute may be open) and on minute and day edges worked by hand
// (J-portfolio-05 #1's wait, #7907; J-ops-console-07's day left, #7895), and names the fix; it stays quiet on the fixed
// code, on an assertion that a value sits on an edge, on a local datetime-local value, in clock.mjs and outside the journeys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden(no-hand-clock)';
const DIR = 'apps/customer/tests/real-app';

/** Each planted file's findings of this rule, as unix-format lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-clock-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(RULE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const at = (out, file, line) => out.find((l) => l.startsWith(`${file}:${line}:`));

// J-portfolio-04.pw.mjs #3 before #7874 (#7871), the lines that read the deposit's candle.
const PORTFOLIO_04_BEFORE = [
  "test('J-portfolio-04 #3 reads a deposit', async ({ page }) => {",
  '  const who = account();',
  '  const before = Date.now();',
  "  expect(fund(who.email, 'BTC', '0.004').tx).toBeTruthy();",
  '  const after = Date.now();',
  '  await signIn(page, who);',
  "  const depositValues = valuesAt('0.004', await closesAround('BTC/USDT', before, after));",
  '  expect(depositValues).toContain(await shown(page));',
  '});',
].join('\n');
// The same lines once the deposit's minute is waited out through clock.mjs.
const PORTFOLIO_04_AFTER = PORTFOLIO_04_BEFORE.replace(
  '  await signIn(page, who);',
  '  await closedMinute(page, after);\n  await signIn(page, who);',
);

test('a candle read at a clock read whose minute may be open fails, naming closedMinute; waited out, it passes', { skip }, () => {
  const before = `${DIR}/J-portfolio-04.pw.mjs`;
  const after = `${DIR}/J-portfolio-04b.pw.mjs`;
  const out = findings({ [before]: PORTFOLIO_04_BEFORE, [after]: PORTFOLIO_04_AFTER });
  const hit = at(out, before, 7);
  assert.ok(hit, out.join('\n'));
  assert.match(hit, /closesAround\(…\) reads a candle at before, after/);
  assert.match(hit, /await closedMinute\(page, after\)` from apps\/customer\/tests\/real-app\/clock\.mjs/);
  assert.deepEqual(
    out.filter((l) => l.startsWith(after)),
    [],
  );
});

test('a closedMinute of another clock read, or after the candle read, does not count', { skip }, () => {
  const other = PORTFOLIO_04_BEFORE.replace(
    '  await signIn(page, who);',
    '  await closedMinute(page, Date.now());\n  await signIn(page, who);',
  );
  const late = PORTFOLIO_04_BEFORE.replace('  expect(depositValues)', '  await closedMinute(page, after);\n  expect(depositValues)');
  const out = findings({ [`${DIR}/J-a.pw.mjs`]: other, [`${DIR}/J-b.pw.mjs`]: late });
  assert.ok(at(out, `${DIR}/J-a.pw.mjs`, 8), out.join('\n'));
  assert.ok(at(out, `${DIR}/J-b.pw.mjs`, 7), out.join('\n'));
});

// Minute, hour and day edges worked by hand, as journeys wrote them: J-portfolio-05 #1's wait before #7911's helper, the
// ops console's "day left" (J-ops-console-07), a date input's day, and midnight set by hand.
const BY_HAND = [
  'export async function steps(page, left, from) {',
  '  const minuteOver = Math.floor(left[1] / 60_000) * 60_000 + 60_000;',
  '  const since = Math.floor(from / HOUR) * HOUR;',
  '  const leftToday = 86_400_000 - (Date.now() % 86_400_000);',
  '  const day = new Date().toISOString().slice(0, 10);',
  '  const minute = new Date(from).toISOString().slice(0, 16);',
  '  const midnight = new Date();',
  '  midnight.setUTCHours(24, 0, 0, 0);',
  '  return [minuteOver, since, leftToday, day, minute, midnight];',
  '}',
].join('\n');

test('a minute, hour or day edge worked by hand fails, naming its helper in clock.mjs', { skip }, () => {
  const file = `${DIR}/J-hand.pw.mjs`;
  const out = findings({ [file]: BY_HAND });
  for (const [line, helper] of [
    [2, 'minuteStart'],
    [3, 'hourStart'],
    [4, 'dayStart'],
    [5, 'utcDay'],
    [6, 'utcMinuteOf'],
    [8, 'dayStart'],
  ]) {
    const hit = at(out, file, line);
    assert.ok(hit, `line ${line}:\n${out.join('\n')}`);
    assert.ok(hit.includes(helper) && hit.includes('clock.mjs'), hit);
  }
  assert.equal(out.length, 6, out.join('\n'));
});

test('an edge assertion, a local datetime-local value, clock.mjs itself and files outside the journeys stay quiet', { skip }, () => {
  const fine = [
    "test('edges', async ({ page }) => {",
    "  expect(candle[0] % DAY_MS, 'opens at a day start').toBe(0);",
    '  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);',
    '  at.setUTCHours(hour, 0, 0, 0);',
    "  const closes = await closesAround('BTC/USDT', Date.parse(row.at), later);",
    '  return local;',
    '});',
  ].join('\n');
  const out = findings({
    [`${DIR}/J-fine.pw.mjs`]: fine,
    [`${DIR}/clock.mjs`]: BY_HAND,
    'services/svc-x/src/day.ts': BY_HAND,
  });
  assert.deepEqual(out, []);
});
