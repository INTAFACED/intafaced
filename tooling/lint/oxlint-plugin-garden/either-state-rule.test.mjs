// garden/no-either-state-match on planted journey files: the weak form fires and names the fix; a pinned state, a
// per-row rule over a set, a list of statuses and a non-journey file do not.
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
const RULE = 'garden(no-either-state-match)';

/** Each planted file's findings of this rule, as `file:line`. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-either-'));
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
const J = 'apps/customer/tests/real-app/J-x-01.pw.mjs';

test('an either-state toContain in a journey step fires and says to pin the one state', skip, () => {
  const out = findings({
    [J]: [
      "test('J-x-01 #5', async () => {",
      "  expect(['unknown', 'pending_retry', 'posting', 'qualified']).toContain(open.state);",
      "  expect.soft(['refunding', 'refunded']).toContain(data.state);",
      '});',
    ].join('\n'),
  });
  assert.equal(out.length, 2, out.join('\n'));
  assert.ok(out[0].startsWith(`${J}:2:`), out[0]);
  assert.ok(out[0].includes('pin the one state the step names'), out[0]);
});

test('a pinned state, a rule over every row, statuses, a list of values and other files pass', skip, () => {
  const clean = [
    "test('J-x-01 #5', async () => {",
    "  expect(open.state).toBe('qualified');",
    "  for (const row of rows) expect(['set', 'blank']).toContain(row.state);",
    "  rows.forEach((r) => expect(['open', 'pending']).toContain(r.status));",
    '  expect([401, 403]).toContain(res.status);',
    '  expect([...bids, ...asks]).toContain(pointed);',
    '  expect([first, second]).not.toContain(third);',
    "  expect(['a']).toContain(x);",
    '});',
  ].join('\n');
  assert.deepEqual(findings({ [J]: clean, 'apps/customer/src/x.test.ts': "expect(['a', 'b']).toContain(x);\n" }), []);
});
