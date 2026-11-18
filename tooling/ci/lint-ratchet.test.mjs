// The lint ratchet on planted pull requests in a throwaway repository: a rise fails and names the rule, a rise paid for
// in the same file passes, a change that switches the rule off in its own .oxlintrc.json is still judged by main's, a
// moved function passes, no rule only prints (a printOnly key left in ratchet.json excuses nothing), a new fixed wait
// fails under main's own ratchet.json, and a rule that replaced a test of added files fails there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, ruleOf, suppressionsOf, TEST_FILE } from './lint-ratchet.mjs';

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

/** A repository whose main holds the config, the real plugin, `starts` and `onMain`; returns helpers to plant a pull request. */
function repo(starts, config = CONFIG, onMain = {}) {
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
    ...onMain,
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

test('no rule only prints: a printOnly key left in ratchet.json does not excuse a rise', skip, () => {
  const r = repo({ printOnly: { 'garden/no-double-cast': 'a planted reason' } });
  try {
    const { code, out } = r.pr({ 'src/b.ts': CAST });
    assert.equal(code, 1, out);
    assert.match(out, /FAILS: \+1/u);
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
    assert.match(
      failed.out,
      /agePast \(the test-age helper in apps\/customer\/tests\/real-app; svc-trade, svc-campaigns and svc-bank have the door today/u,
    );
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

test('one rule with several kinds: a removed copy of one kind never pays for an added copy of another', skip, () => {
  const svc = 'services/svc-x/src/x.ts';
  const r = repo(
    ENFORCING,
    { ...CONFIG, rules: { 'garden/use-shared-helper': 'error' } },
    { [svc]: 'export const get = (u: string) => fetch(u);\n' },
  );
  try {
    // The known-good state: the same kind removed and added in one file passes.
    const same = r.pr({ [svc]: 'export const get = (u: string) => fetch(`${u}/v2`);\n' });
    assert.equal(same.code, 0, same.out);
    // The planted fault: the fetch copy goes and a local money scale arrives in the same file.
    const { code, out } = r.pr({ [svc]: 'export const SCALE = 10n ** 18n;\n' });
    assert.equal(code, 1, out);
    assert.match(out, /garden\/use-shared-helper\[local-scale\] rose from 0 to 1/u);
  } finally {
    r.done();
  }
});

test('the verdict: names and sums', () => {
  assert.equal(ruleOf({ code: 'garden(no-double-cast)' }), 'garden/no-double-cast');
  // One rule, several kinds: each kind is its own count, so one kind's removal never pays for another's addition.
  assert.equal(
    ruleOf({ code: 'garden(use-shared-helper)', message: '[local-scale] local `10n ** 18n` scale: import the scale' }),
    'garden/use-shared-helper[local-scale]',
  );
  assert.equal(ruleOf({ code: 'garden(no-double-cast)', message: '`as unknown as` turns type checking off' }), 'garden/no-double-cast');
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

// project-state#2963: main's config turns on four built-in rules for service and package source outside tests; each
// planted new finding in a touched file fails and prints its fix, and an untouched file's old findings do not count.
const REAL_CONFIG = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
const REAL_STARTS = JSON.parse(readFileSync(join(ROOT, 'tooling', 'lint', 'ratchet.json'), 'utf8'));
const OLD = 'services/svc-x/src/old.ts';
const OLD_TEXT =
  'export function old(a: number, b: number, c: number, d: number) {\n  console.log(a);\n  const m = new Map<number, number>();\n  return (m.get(b)! + c + d) as number;\n}\n';
for (const [rule, line, fix] of [
  ['eslint/no-console', 'export function f() {\n  console.log("x");\n}\n', /fix: log through the service's structured logger/u],
  [
    'eslint/max-params',
    'export function f(a: number, b: number, c: number, d: number) {\n  return a + b + c + d;\n}\n',
    /fix: take one object of named fields/u,
  ],
  [
    'typescript/consistent-type-assertions',
    'export const f = (v: unknown) => v as string;\n',
    /fix: don't cast: parse the value at its boundary.*`satisfies T`/u,
  ],
  ['typescript/no-non-null-assertion', 'export const f = (m: Map<string, number>) => m.get("a")!;\n', /fix: don't assert with `!`/u],
]) {
  test(`${rule}: a new finding in a touched service file fails and names the fix; an untouched file's old ones do not`, skip, () => {
    const r = repo(REAL_STARTS, REAL_CONFIG, { [OLD]: OLD_TEXT });
    try {
      const clean = r.pr({ 'services/svc-x/src/new.ts': 'export const ok = 1;\n' });
      assert.equal(clean.code, 0, clean.out);
      const { code, out } = r.pr({ 'services/svc-x/src/new.ts': line });
      assert.equal(code, 1, out);
      assert.match(out, new RegExp(`${rule.replace('/', '\\/')} rose from 0 to 1`, 'u'));
      assert.match(out, fix);
      const inTest = r.pr({ 'services/svc-x/src/new.ts': 'export const ok = 1;\n', 'services/svc-x/src/new.test.ts': line });
      assert.equal(inTest.code, 0, `${rule} stays off in tests: ${inTest.out}`);
    } finally {
      r.done();
    }
  });
}

test('a new suppression in a touched product file fails like the finding it silences; old ones and test files do not', skip, () => {
  const silenced = 'services/svc-x/src/s.ts';
  const r = repo(REAL_STARTS, REAL_CONFIG, { [silenced]: '// oxlint-disable-next-line no-console -- kept\nconsole.log(1);\n' });
  try {
    const held = r.pr({ [silenced]: '// oxlint-disable-next-line no-console -- kept\nconsole.log(2);\n' });
    assert.equal(held.code, 0, held.out);
    // The past mistake (product suppressions rose 89 to 100, 11 to 18 Nov): a finding silenced instead of fixed.
    const { code, out } = r.pr({
      'services/svc-x/src/new.ts': 'export function f() {\n  // oxlint-disable-next-line no-console -- quiet\n  console.log("x");\n}\n',
    });
    assert.equal(code, 1, out);
    assert.match(out, /suppression\/no-console rose from 1 to 2/u);
    assert.match(out, /services\/svc-x\/src\/new\.ts:2 {2}a suppression silences this rule here/u);
    assert.match(out, /fix: fix the finding instead of silencing it/u);
  } finally {
    r.done();
  }
});

test('suppressions: names, lines and the test-file door', () => {
  assert.deepEqual(
    suppressionsOf(
      'a\n// oxlint-disable-next-line react-hooks/exhaustive-deps -- why\n/* eslint-disable @typescript-eslint/no-explicit-any, no-console */\n// eslint-disable-line\n',
    ),
    [
      { rule: 'suppression/react-hooks/exhaustive-deps', line: 2 },
      { rule: 'suppression/typescript/no-explicit-any', line: 3 },
      { rule: 'suppression/no-console', line: 3 },
      { rule: 'suppression/(every rule)', line: 4 },
    ],
  );
  assert.ok(TEST_FILE.test('services/a/src/x.test.ts') && TEST_FILE.test('apps/customer/tests/real-app/j.pw.mjs'));
  assert.ok(!TEST_FILE.test('services/svc-bank/src/partner/test-partner.ts'), 'a TEST stand-in is product code');
});
