// The lint ratchet on planted pull requests in a throwaway repository: a rise fails and names the rule, a rise paid for
// in the same file passes, a change that switches the rule off in its own .oxlintrc.json is still judged by main's, a
// moved function passes, a new rule only prints for its first days, and a rule that replaced a deleted test enforces now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, enforcesFrom, ruleOf } from './lint-ratchet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'tooling', 'ci', 'lint-ratchet.mjs');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = { skip: !existsSync(OXLINT) && 'no node_modules' };
// A hook's GIT_* variables would point git at the real repository; CI's GITHUB_ACTIONS would make it fetch main.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'GITHUB_ACTIONS'));

const CAST = 'export const n = ("1" as unknown as number) + 1;\n';
const CONFIG = {
  jsPlugins: ['./tooling/lint/oxlint-plugin-garden/index.js'],
  categories: {},
  rules: { 'garden/no-double-cast': 'error', 'garden/no-promise-copy': 'error' },
};

/** A repository whose main holds the config, the real plugin and `starts`; returns helpers to plant a pull request. */
function repo(starts) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-ratchet-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        rmSync(join(dir, path));
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  cpSync(join(ROOT, 'tooling', 'lint', 'oxlint-plugin-garden'), join(dir, 'tooling', 'lint', 'oxlint-plugin-garden'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  write({
    '.gitignore': 'node_modules\n',
    '.oxlintrc.json': CONFIG,
    'tooling/lint/ratchet.json': starts,
    'src/a.ts': `${CAST}export function moved() {\n  return ("x" as unknown as number) * 2;\n}\n`,
  });
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  return {
    pr(files) {
      write(files);
      git('add', '-A');
      git('commit', '-q', '--no-verify', '-m', 'pr');
      const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: ENV, encoding: 'utf8' });
      return { code: run.status, out: `${run.stdout}${run.stderr}` };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
// no-double-cast started long ago, so it enforces; no-promise-copy replaced a deleted test, so it enforces from the start.
const ENFORCING = { printOnlyDays: 7, enforceFromStart: ['garden/no-promise-copy'], started: { 'garden/no-double-cast': '2000-01-01' } };

test('a pull request adding one `as unknown as` fails and names the rule', skip, () => {
  const r = repo(ENFORCING);
  try {
    const { code, out } = r.pr({ 'src/b.ts': CAST });
    assert.equal(code, 1, out);
    assert.match(out, /garden\/no-double-cast rose from 0 to 1/u);
    assert.match(out, /src\/b\.ts/u);
  } finally {
    r.done();
  }
});

test('adding one and removing one in a touched file passes', skip, () => {
  const r = repo(ENFORCING);
  try {
    const { code, out } = r.pr({
      'src/a.ts': `export const n = Number("1") + 1;\nexport function moved() {\n  return ("x" as unknown as number) * 2;\n}\nexport const m = ("2" as unknown as number);\n`,
    });
    assert.equal(code, 0, out);
    assert.match(out, /garden\/no-double-cast \| 2 \| 2 \| held/u);
  } finally {
    r.done();
  }
});

test("switching the rule off in the pull request's own .oxlintrc.json still fails: main's config judges it", skip, () => {
  const r = repo(ENFORCING);
  try {
    const { code, out } = r.pr({
      '.oxlintrc.json': { ...CONFIG, rules: { ...CONFIG.rules, 'garden/no-double-cast': 'off' } },
      'src/b.ts': CAST,
    });
    assert.equal(code, 1, out);
    assert.match(out, /garden\/no-double-cast rose/u);
  } finally {
    r.done();
  }
});

test('a function moved from one file to a new one does not fail', skip, () => {
  const r = repo(ENFORCING);
  try {
    const { code, out } = r.pr({
      'src/a.ts': CAST,
      'src/c.ts': 'export function moved() {\n  return ("x" as unknown as number) * 2;\n}\n',
    });
    assert.equal(code, 0, out);
  } finally {
    r.done();
  }
});

test('a rule in its first 7 days prints the rise and the day it starts failing, and fails nothing', skip, () => {
  const r = repo({ printOnlyDays: 7, enforceFromStart: [], started: {} });
  try {
    const { code, out } = r.pr({ 'src/b.ts': CAST });
    assert.equal(code, 0, out);
    assert.match(out, /rose \+1; prints only, fails from \d{4}-\d{2}-\d{2}/u);
  } finally {
    r.done();
  }
});

test('a rule that replaced a deleted test enforces from its first day', skip, () => {
  const r = repo({ printOnlyDays: 7, enforceFromStart: ['garden/no-promise-copy'], started: {} });
  try {
    const { code, out } = r.pr({ 'apps/customer/src/screens/trade/x/copy.ts': "export const a = { title: 'Coming soon' };\n" });
    assert.equal(code, 1, out);
    assert.match(out, /garden\/no-promise-copy rose from 0 to 1/u);
  } finally {
    r.done();
  }
});

test('the verdict: names, dates and sums', () => {
  assert.equal(ruleOf({ code: 'garden(no-double-cast)' }), 'garden/no-double-cast');
  assert.equal(ruleOf({ message: 'Unused oxlint-disable directive (no problems were reported).' }), 'unused-suppression');
  assert.equal(enforcesFrom('x/y', { printOnlyDays: 7, started: {} }, '2026-11-20T10:00:00Z'), '2026-11-27');
  assert.equal(enforcesFrom('x/y', { enforceFromStart: ['x/y'] }, '2026-11-20'), null);
  const v = compare({ 'a/b': { f: 1 } }, { 'a/b': { f: 1, g: 1 } }, { enforceFromStart: ['a/b'] }, null);
  assert.equal(v.failing.length, 1);
  assert.deepEqual(v.failing[0].files, ['f', 'g']);
  assert.equal(compare({ 'a/b': { f: 2 } }, { 'a/b': { g: 1 } }, { enforceFromStart: ['a/b'] }, null).failing.length, 0, 'a fall passes');
});

test('a rule that replaced a test of added files fails at once in an added file, and only prints a rise in an existing one', skip, () => {
  const starts = { printOnlyDays: 7, enforceFromStart: [], enforceAddedFromStart: ['garden/no-double-cast'], started: {} };
  const added = repo(starts);
  try {
    const { code, out } = added.pr({ 'src/b.ts': CAST });
    assert.equal(code, 1, out);
    assert.match(out, /garden\/no-double-cast fires in file\(s\) this change adds \(src\/b\.ts\)/u);
  } finally {
    added.done();
  }
  const existing = repo(starts);
  try {
    const { code, out } = existing.pr({
      'src/a.ts': `${CAST}export function moved() {
  return ("x" as unknown as number) * 2;
}
export const m = ("3" as unknown as number);
`,
    });
    assert.equal(code, 0, out);
    assert.match(out, /rose \+1; prints only/u);
  } finally {
    existing.done();
  }
});
