// The ratchets that compare a pull request with main (lint-ratchet, look-drift) on main-bisect's automatic revert, in a
// throwaway repository: a culprit deletes code today's rules count, and its exact revert passes both, judged against the
// culprit's parent (exact-revert.mjs autoRevertOf; project-state#3635, where intafaced #9482, the revert of #9426, failed
// both). One planted extra finding on top of the revert, a second commit, or another author is judged as today and fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
