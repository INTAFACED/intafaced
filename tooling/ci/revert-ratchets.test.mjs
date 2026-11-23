// The ratchets that compare a pull request with main (lint-ratchet, look-drift) on main-bisect's automatic revert, in a
// throwaway repository: a culprit deletes code today's rules count, and its exact revert passes both, judged against the
// culprit's parent (exact-revert.mjs autoRevertOf; project-state#3635, where intafaced #9482, the revert of #9426, failed
// both). One planted extra finding on top of the revert, a second commit, or another author is judged as today and fails.
// The two committed lists that may only fall (kit-ceilings.json, volt-off-kit.json; exact-revert.mjs judgedCopy) the same
// way: the revert may restore what the culprit's parent held, never more (project-state#3697).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgedCopy } from './exact-revert.mjs';
import { judge } from '../lint/kit-ceilings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = { skip: !existsSync(OXLINT) && 'no node_modules' };
// A hook's GIT_* variables would point git at the real repository; CI's GITHUB_ACTIONS would make lint-ratchet fetch main,
// and CI's own pull request variables would describe another pull request.
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith('GIT_') && !k.startsWith('PR_') && !['GITHUB_ACTIONS', 'GITHUB_REPOSITORY'].includes(k),
  ),
);
const FILE = 'packages/ui/src/lit/fx/glass.ts';
const RESTORED = 'export const n = ("1" as unknown as number) + 1;\nexport const glass = "#ffffff";\n';

/** Main: FILE, then a culprit that deletes it, then one more commit; a `revert/auto-` branch holding `git revert` of it. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'revert-ratchets-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  cpSync(join(ROOT, 'tooling', 'lint', 'oxlint-plugin-garden'), join(dir, 'tooling', 'lint', 'oxlint-plugin-garden'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  write('.gitignore', 'node_modules\n');
  write('.oxlintrc.json', {
    jsPlugins: ['./tooling/lint/oxlint-plugin-garden/index.js'],
    categories: {},
    rules: { 'garden/no-double-cast': 'error' },
  });
  write('tooling/lint/ratchet.json', {});
  write(FILE, RESTORED);
  write('packages/ui/src/lit/fx/keep.ts', 'export const keep = 1;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'main before the culprit');
  rmSync(join(dir, FILE));
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'culprit: delete the glass');
  const culprit = git('rev-parse', 'HEAD');
  write('packages/ui/src/lit/fx/keep.ts', 'export const keep = 2;\n');
  git('commit', '-q', '--no-verify', '-am', 'main moves on');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', `revert/auto-${culprit.slice(0, 10)}`);
  git('revert', '--no-edit', culprit);
  const pr = {
    PR_HEAD_REF: `revert/auto-${culprit.slice(0, 10)}`,
    PR_AUTHOR: 'intafaced-mac-agents[bot]',
    PR_AUTHOR_TYPE: 'Bot',
    PR_COMMITS: '1',
    PR_HEAD_REPO: 'o/r',
    GITHUB_REPOSITORY: 'o/r',
  };
  return {
    /** Add `extra` to FILE in the revert's own commit. */
    plant(extra) {
      appendFileSync(join(dir, FILE), extra);
      git('commit', '-q', '--no-verify', '--amend', '--no-edit', '-a');
    },
    /** Both gates' exit codes, for this pull request as `over` describes it. */
    gates(over = {}) {
      const env = { ...ENV, ...pr, PR_HEAD_SHA: git('rev-parse', 'HEAD'), ...over };
      const run = (script) => spawnSync(process.execPath, [join(ROOT, 'tooling', 'ci', script)], { cwd: dir, env, encoding: 'utf8' });
      const lint = run('lint-ratchet.mjs');
      const look = run('look-drift.mjs');
      return { lint: lint.status, look: look.status, out: `${lint.stdout}${lint.stderr}${look.stdout}${look.stderr}` };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("main-bisect's exact revert of a culprit that deleted counted code passes both ratchets, judged against its parent", skip, () => {
  const r = repo();
  try {
    const g = r.gates();
    assert.deepEqual([g.lint, g.look], [0, 0], g.out);
    assert.match(g.out, /lint-ratchet: main-bisect's automatic revert of [0-9a-f]{10}, judged against/);
    assert.match(g.out, /look-drift: main-bisect's automatic revert of [0-9a-f]{10}, judged against/);
  } finally {
    r.done();
  }
});

test('the same revert by another author, or with two commits, is judged against main as today and fails both', skip, () => {
  const r = repo();
  try {
    for (const over of [
      { PR_AUTHOR: 'someone', PR_AUTHOR_TYPE: 'User' },
      { PR_COMMITS: '2' },
      { PR_HEAD_REF: 'fix/x' },
      {
        PR_HEAD_REPO: 'fork/r',
      },
    ]) {
      const g = r.gates(over);
      assert.deepEqual([g.lint, g.look], [1, 1], `${JSON.stringify(over)}\n${g.out}`);
      assert.doesNotMatch(g.out, /automatic revert/);
    }
  } finally {
    r.done();
  }
});

test('planted: one more finding on top of the revert fails both', skip, () => {
  const r = repo();
  try {
    r.plant('export const m = ("2" as unknown as number);\n');
    const g = r.gates();
    assert.deepEqual([g.lint, g.look], [1, 1], g.out);
    assert.match(g.out, /garden\/no-double-cast/);
  } finally {
    r.done();
  }
});

const CEILINGS = 'apps/customer/kit-ceilings.json';
const LIST = 'apps/customer/src/app/volt-off-kit.json';
const R = 'garden/no-raw-control';
/** Four files between a.tsx and b.tsx, so the culprit's line and main's later one are apart, as git revert needs. */
const KEEP = { 'k1.tsx': 1, 'k2.tsx': 1, 'k3.tsx': 1, 'k4.tsx': 1 };
const ceil = (a, b, more = {}) => ({ [R]: { 'a.tsx': a, ...KEEP, 'b.tsx': b, ...more } });

/** Main holds two ceilings and two off-kit rooms; a culprit lowers one ceiling and drops one room (a Volt batch); main
 *  then lowers the other ceiling; a `revert/auto-` branch holds `git revert` of the culprit. No linter needed. */
function lists() {
  const dir = mkdtempSync(join(tmpdir(), 'revert-lists-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, value) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  };
  const commit = (message) => git('commit', '-q', '--no-verify', '-am', message);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  write(CEILINGS, ceil(3, 2));
  write(LIST, ['/x', '/k1', '/k2', '/k3', '/y']);
  git('add', '-A');
  commit('main before the culprit');
  write(CEILINGS, ceil(1, 2));
  write(LIST, ['/k1', '/k2', '/k3', '/y']);
  commit('culprit: a Volt batch lowers a.tsx and takes /x off the list');
  const culprit = git('rev-parse', 'HEAD');
  write(CEILINGS, ceil(1, 1));
  commit('main moves on: b.tsx lowered');
  const main = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', `revert/auto-${culprit.slice(0, 10)}`);
  git('revert', '--no-edit', culprit);
  const pr = {
    PR_HEAD_REF: `revert/auto-${culprit.slice(0, 10)}`,
    PR_AUTHOR: 'intafaced-mac-agents[bot]',
    PR_AUTHOR_TYPE: 'Bot',
    PR_COMMITS: '1',
    PR_HEAD_REPO: 'o/r',
    GITHUB_REPOSITORY: 'o/r',
  };
  const read = (args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    write,
    /** Fold the tree's edits into the revert's own commit: still one commit, no longer `git revert` alone. */
    amend: () => git('commit', '-q', '--no-verify', '--amend', '--no-edit', '-a'),
    /** The two tests' verdicts on the tree as it stands, for this pull request as `over` describes it. */
    judged(over = {}) {
      const env = { ...pr, PR_HEAD_SHA: git('rev-parse', 'HEAD'), ...over };
      const base = judgedCopy(CEILINGS, { env, main, fork: main, read });
      const before = judgedCopy(LIST, { env, main, fork: main, read });
      const now = JSON.parse(readFileSync(join(dir, LIST), 'utf8'));
      const ceilings = JSON.parse(readFileSync(join(dir, CEILINGS), 'utf8'));
      return {
        raised: judge(ceilings, ceilings, base).map((p) => `${p.kind} ${p.file} ${p.ceiling} over ${p.was}`),
        added: now.filter((room) => !before.includes(room)),
      };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("kit ceilings and the off-kit list: main-bisect's exact revert restores its culprit's parent's, and passes", () => {
  const r = lists();
  try {
    assert.deepEqual(r.judged(), { raised: [], added: [] });
    // Before this change, judged against main alone, the same revert failed both (intafaced #10027, #9948, #9903, #9804).
    assert.deepEqual(r.judged({ PR_AUTHOR: 'someone', PR_AUTHOR_TYPE: 'User' }), {
      raised: ['raised a.tsx 3 over 1'],
      added: ['/x'],
    });
  } finally {
    r.done();
  }
});

test('planted: an ordinary change that raises a ceiling or lists a room fails, whatever its branch is called', () => {
  const r = lists();
  try {
    for (const over of [
      { PR_AUTHOR: 'someone', PR_AUTHOR_TYPE: 'User' },
      { PR_HEAD_REF: 'fix/x' },
      { PR_COMMITS: '2' },
      { PR_HEAD_REPO: 'fork/r' },
    ])
      assert.notDeepEqual(r.judged(over), { raised: [], added: [] }, JSON.stringify(over));
  } finally {
    r.done();
  }
});

test('planted: a revert/auto- branch whose one commit is the revert plus one raise is no proven revert, and fails', () => {
  const r = lists();
  try {
    r.write(CEILINGS, ceil(3, 1, { 'c.tsx': 1 }));
    r.write(LIST, ['/x', '/k1', '/k2', '/k3', '/y', '/z']);
    r.amend();
    assert.deepEqual(r.judged(), { raised: ['raised a.tsx 3 over 1', 'raised c.tsx 1 over 0'], added: ['/x', '/z'] });
  } finally {
    r.done();
  }
});

test("planted: a proven revert's tree holding more than its culprit's parent fails on the excess alone", () => {
  const r = lists();
  try {
    // The revert itself is exact; the tree judged (its merge with main) holds one ceiling and one room past X^'s.
    r.write(CEILINGS, ceil(4, 1));
    r.write(LIST, ['/x', '/k1', '/k2', '/k3', '/y', '/z']);
    assert.deepEqual(r.judged(), { raised: ['raised a.tsx 4 over 3'], added: ['/z'] });
  } finally {
    r.done();
  }
});

test("ci.yml's Doctrine gates job fetches nothing shallow: a --depth fetch cuts main's history, and every later step's revert proof", () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const from = ci.indexOf('\n  gates:\n');
  const next = /\n  [a-z][a-z0-9-]*:\n/g;
  next.lastIndex = from + 1;
  const job = ci.slice(from, next.exec(ci)?.index ?? ci.length);
  assert.ok(job.includes('name: Doctrine gates'), 'the Doctrine gates job is where this test looks for it');
  assert.deepEqual(
    job.split('\n').filter((l) => /git fetch\b.*--depth/.test(l) && !l.trim().startsWith('#')),
    [],
  );
});
