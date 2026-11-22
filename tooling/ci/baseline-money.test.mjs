import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { check, moneyProblems, withRuleFlags } from './baseline-money.mjs';

const SCRIPT = resolve(import.meta.dirname, 'baseline-money.mjs');

/** A checkout shaped like main on 22 Nov after #9539: an admin step and a customer step; `adminMoney` gives apps/admin
 *  its devDependency on the ledger client. */
function tree({ adminMoney, entries }) {
  const root = mkdtempSync(join(tmpdir(), 'baseline-money-'));
  const put = (f, v) => {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);
  };
  put('docs/roadmap/journeys.json', [
    { id: 'J-ops-console-22', steps: [{ n: 3, slices: ['S-admin'] }] },
    { id: 'J-c-01', steps: [{ n: 1, slices: ['S-customer'] }] },
  ]);
  put('docs/roadmap/slices.json', [
    { id: 'S-admin', touches: ['admin: ops console'] },
    { id: 'S-customer', touches: ['customer: home'] },
  ]);
  put('packages/ledger-client/package.json', { name: '@intafaced/ledger-client' });
  put('apps/customer/package.json', { name: '@intafaced/customer' });
  put('apps/admin/package.json', {
    name: '@intafaced/admin',
    ...(adminMoney ? { devDependencies: { '@intafaced/ledger-client': 'workspace:*' } } : {}),
  });
  put('docs/runbooks/journey-baseline.json', { run: { number: 1 }, steps: entries });
  return root;
}
const unbuilt = (step, money) => ({ step, file: 'x.pw.mjs', state: 'unbuilt', money, why: 'not built' });
const run = (root, ...args) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};

test("main's tree after #9539: an admin step's flag left false fails, naming the step, its flag, the rule's and the fix", () => {
  const root = tree({ adminMoney: true, entries: [unbuilt('J-ops-console-22#3', false), unbuilt('J-c-01#1', false)] });
  try {
    const r = run(root);
    assert.equal(r.code, 1);
    assert.match(r.out, /J-ops-console-22#3: money false in the baseline, true by the rule/);
    assert.doesNotMatch(r.out, /J-c-01#1/);
    assert.match(r.out, /node tooling\/ci\/baseline-money\.mjs --write/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the fixed tree passes: the input change undone, or the flag rewritten by --write', () => {
  const undone = tree({ adminMoney: false, entries: [unbuilt('J-ops-console-22#3', false), unbuilt('J-c-01#1', false)] });
  const moved = tree({ adminMoney: true, entries: [unbuilt('J-ops-console-22#3', false), unbuilt('J-c-01#1', false)] });
  try {
    assert.equal(run(undone).code, 0);
    const before = readFileSync(join(moved, 'docs/runbooks/journey-baseline.json'), 'utf8');
    const w = run(moved, '--write');
    assert.equal(w.code, 0, w.out);
    const after = readFileSync(join(moved, 'docs/runbooks/journey-baseline.json'), 'utf8');
    assert.equal(after, before.replace('"money": false', '"money": true'), 'only the stale flag changes');
    assert.equal(run(moved).code, 0);
  } finally {
    rmSync(undone, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});

test('a regression entry on a money step fails, and --write leaves its state alone', () => {
  const root = tree({
    adminMoney: true,
    entries: [{ step: 'J-ops-console-22#3', file: 'x', state: 'regression', money: false, issue: 1, why: 'w' }],
  });
  try {
    const r = run(root, '--write');
    assert.equal(r.code, 1);
    assert.match(r.out, /money step may be in the baseline only as unbuilt:\n {2}J-ops-console-22#3/);
    const e = JSON.parse(readFileSync(join(root, 'docs/runbooks/journey-baseline.json'), 'utf8')).steps[0];
    assert.deepEqual([e.state, e.money], ['regression', true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a step the rule does not know counts as money, as the verdict counts it', () => {
  assert.deepEqual(moneyProblems({ steps: [unbuilt('J-gone-01#1', false)] }, {}).stale, [{ step: 'J-gone-01#1', flag: false, rule: true }]);
});

test('withRuleFlags sets only the named entry, and refuses a step it cannot find', () => {
  const text = `${JSON.stringify({ steps: [unbuilt('J-a-01#1', false), unbuilt('J-a-01#10', false)] }, null, 2)}\n`;
  const out = withRuleFlags(text, [{ step: 'J-a-01#1', rule: true }]);
  assert.deepEqual(
    JSON.parse(out).steps.map((e) => e.money),
    [true, false],
  );
  assert.throws(() => withRuleFlags(text, [{ step: 'J-b-01#1', rule: true }]), /not in the baseline/);
});

test('an empty tree or an empty baseline refuses rather than passing over nothing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'baseline-money-'));
  const none = tree({ adminMoney: false, entries: [] });
  try {
    assert.match(check(empty).lines[0], /BASELINE MONEY FAILED: cannot read/);
    assert.equal(check(empty).ok, false);
    assert.match(check(none).lines[0], /has no steps/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});
