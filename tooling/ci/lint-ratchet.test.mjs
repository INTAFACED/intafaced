// The lint ratchet on planted pull requests in a throwaway repository: a rise fails and names the rule, a rise paid for
// in the same file passes, a change that switches the rule off in its own .oxlintrc.json is still judged by main's, a
// moved function passes, a rule named in printOnly only prints, a new fixed wait fails under main's own ratchet.json,
// and a rule that replaced a test of added files fails there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, ruleOf } from './lint-ratchet.mjs';

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
function repo(starts, config = CONFIG) {
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
    '.oxlintrc.json': config,
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
const ENFORCING = {};

test('a pull request adding one `as unknown as` fails and names the rule', skip, () => {
  const r = repo(ENFORCING);
  try {
    const { code, out } = r.pr({ 'src/b.ts': CAST });
    assert.equal(code, 1, out);
    assert.match(out, /garden\/no-double-cast rose from 0 to 1/u);
    assert.match(out, /src\/b\.ts:1 {2}`as unknown as` turns type checking off here: narrow with a type guard/u);
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

test('a rule named in printOnly prints the rise and fails nothing', skip, () => {
  const r = repo({ printOnly: { 'garden/no-double-cast': 'a planted reason' } });
  try {
    const { code, out } = r.pr({ 'src/b.ts': CAST });
    assert.equal(code, 0, out);
    assert.match(out, /rose \+1; prints only/u);
  } finally {
    r.done();
  }
});

test("main's ratchet.json fails a new fixed wait in a journey and in a unit test, and keeps one that says why", skip, () => {
  const starts = JSON.parse(readFileSync(join(ROOT, 'tooling', 'lint', 'ratchet.json'), 'utf8'));
  const waits = { 'garden/no-wait-for-timeout': 'error', 'garden/no-real-clock-wait-in-tests': 'error' };
  const r = repo(starts, { ...CONFIG, rules: { ...CONFIG.rules, ...waits } });
  try {
    const failed = r.pr({
      'apps/customer/tests/real-app/x.pw.mjs': 'export async function t(page) {\n  await page.waitForTimeout(61_000);\n}\n',
      'src/x.test.ts': 'export async function t() {\n  await new Promise((r) => setTimeout(r, 50));\n}\n',
    });
    assert.equal(failed.code, 1, failed.out);
    assert.match(failed.out, /garden\/no-wait-for-timeout rose from 0 to 1/u);
    assert.match(failed.out, /garden\/no-real-clock-wait-in-tests rose from 0 to 1/u);
    assert.match(failed.out, /agePast \(apps\/customer\/tests\/real-app\/test-age\.mjs; svc-trade has the door today/u);
  } finally {
    r.done();
  }
  const k = repo(starts, { ...CONFIG, rules: { ...CONFIG.rules, ...waits } });
  try {
    const kept = k.pr({
      'apps/customer/tests/real-app/y.pw.mjs':
        'export async function t(page) {\n  // oxlint-disable-next-line garden/no-wait-for-timeout -- proves no second toast arrives\n  await page.waitForTimeout(500);\n}\n',
    });
    assert.equal(kept.code, 0, kept.out);
  } finally {
    k.done();
  }
});

test('a copy rule fails a planted promise in the Trade lane', skip, () => {
  const r = repo(ENFORCING);
  try {
    const { code, out } = r.pr({ 'apps/customer/src/screens/trade/x/copy.ts': "export const a = { title: 'Coming soon' };\n" });
    assert.equal(code, 1, out);
    assert.match(out, /garden\/no-promise-copy rose from 0 to 1/u);
  } finally {
    r.done();
  }
});

test('the verdict: names and sums', () => {
  assert.equal(ruleOf({ code: 'garden(no-double-cast)' }), 'garden/no-double-cast');
  assert.equal(ruleOf({ message: 'Unused oxlint-disable directive (no problems were reported).' }), 'unused-suppression');
  const v = compare({ 'a/b': { f: 1 } }, { 'a/b': { f: 1, g: 1 } }, {});
  assert.equal(v.failing.length, 1);
  assert.deepEqual(v.failing[0].files, ['g'], 'only the file that rose');
  assert.equal(compare({ 'a/b': { f: 2 } }, { 'a/b': { g: 1 } }, {}).failing.length, 0, 'a fall passes');
});

test('a rule that replaced a test of added files fails in an added file even when a removal pays for it', skip, () => {
  const r = repo({ failInAddedFiles: ['garden/no-double-cast'] });
  try {
    const { code, out } = r.pr({ 'src/a.ts': 'export const n = Number("1") + 1;\n', 'src/b.ts': CAST });
    assert.equal(code, 1, out);
    assert.match(out, /garden\/no-double-cast fires in file\(s\) this change adds \(src\/b\.ts\)/u);
  } finally {
    r.done();
  }
});
