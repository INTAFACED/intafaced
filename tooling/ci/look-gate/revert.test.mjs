// The look gate on main-bisect's automatic revert (revert.mjs revertParent, policy.mjs restoredFindings;
// project-state#3697). Replayed: the three reverts of 22 Nov the gate blocked (intafaced #10027, #9903, #9804), on the
// findings their runs recorded and the culprit's own run recorded at its base, pass. Planted, each still blocks: an
// ordinary pull request adding a finding; a `revert/auto-` branch the proof refuses (a human author, two commits, the
// revert plus one more change); a proven revert whose head has a finding the culprit's parent lacked; a parent build
// that is not the culprit's parent.
// Run: node --test tooling/ci/look-gate/revert.test.mjs (also by the tooling-tests gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prVerdict, restoredFindings } from './policy.mjs';
import { BUILT_FROM, revertParent } from './revert.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPLAY = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'look-revert-replay-22-nov.json'), 'utf8'));
const TODAY = '2026-11-23';
// A hook's GIT_* variables would point git at the real repository; CI's own pull request variables describe another one.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('PR_')));

/** The gate's decision on a run's new findings, judged against X^'s rows when the revert is proven (prMain's step 4). */
function decide({ fresh, litTargets, parentRows, revert }) {
  const kept = revert?.culprit ? restoredFindings(fresh, parentRows).kept : fresh;
  return prVerdict({ fresh: kept, litTargets: new Set(litTargets), today: TODAY });
}

test('replay: each of the three reverts blocked then, on findings on the new-look rooms its culprit changed', () => {
  for (const c of REPLAY) {
    assert.ok(c.blockedAs.includes('block'), `#${c.revert} was blocked`);
    assert.equal(decide({ ...c, revert: null }).mode, 'block', `#${c.revert} judged as any pull request still blocks`);
  }
});

test("replay: judged against the culprit's parent, none of the three blocks, and every blocking finding was its parent's", () => {
  for (const c of REPLAY) {
    const { kept, restored } = restoredFindings(c.fresh, c.parentRows);
    assert.equal(decide({ ...c, revert: { culprit: c.culprit } }).mode, 'pass', `#${c.revert}`);
    assert.deepEqual(
      kept.filter((f) => c.litTargets.includes(f.target)),
      [],
      `#${c.revert}: no finding on a new-look page is the revert's own`,
    );
    assert.ok(restored.length > 0, `#${c.revert} restored what its culprit removed`);
  }
});

test("planted (c): a proven revert whose head adds a finding the culprit's parent lacked still blocks", () => {
  const c = REPLAY[0];
  const target = c.litTargets[0];
  const extra = {
    target,
    viewport: 'phone',
    kind: 'contrast',
    items: ['p.planted "Planted" 1.20 < 4.5 (worst pixel under it rgb(0,0,0), box at 1,1)'],
  };
  const v = decide({ ...c, fresh: [...c.fresh, extra], revert: { culprit: c.culprit } });
  assert.equal(v.mode, 'block');
  assert.deepEqual(v.blocking, [extra]);
  const unseen = { target: '/never-drawn-by-x-parent', viewport: 'phone', kind: 'axe', items: ['color-contrast ×1: p'] };
  assert.equal(
    decide({ ...c, litTargets: [...c.litTargets, unseen.target], fresh: [unseen], revert: { culprit: c.culprit } }).mode,
    'block',
  );
});

/** Main: a room, a culprit that changes it, one more commit; a `revert/auto-` branch holding `git revert` of the culprit. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'look-revert-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const read = (args) => execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  write('apps/customer/src/screens/buy/Buy.tsx', 'export const Buy = () => <button className="faint">Enter an amount</button>;\n');
  write('apps/customer/src/screens/keep.ts', 'export const keep = 1;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'main before the culprit');
  write('apps/customer/src/screens/buy/Buy.tsx', 'export const Buy = () => <Button>Enter an amount</Button>;\n');
  git('commit', '-q', '--no-verify', '-am', 'culprit: the buy card draws from the kit');
  const culprit = git('rev-parse', 'HEAD');
  write('apps/customer/src/screens/keep.ts', 'export const keep = 2;\n');
  git('commit', '-q', '--no-verify', '-am', 'main moves on');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', `revert/auto-${culprit.slice(0, 10)}`);
  git('revert', '--no-edit', culprit);
  const parentBuild = mkdtempSync(join(tmpdir(), 'look-revert-parent-'));
  writeFileSync(join(parentBuild, BUILT_FROM), `${git('rev-parse', `${culprit}^`)}\n`);
  const env = () => ({
    PR_HEAD_REF: `revert/auto-${culprit.slice(0, 10)}`,
    PR_AUTHOR: 'intafaced-mac-agents[bot]',
    PR_AUTHOR_TYPE: 'Bot',
    PR_COMMITS: '1',
    PR_HEAD_REPO: 'o/r',
    GITHUB_REPOSITORY: 'o/r',
    PR_HEAD_SHA: git('rev-parse', 'HEAD'),
  });
  const judge = (over = {}, dir2 = parentBuild) => revertParent({ env: { ...env(), ...over }, base: 'origin/main', read, dir: dir2 });
  return { git, write, culprit, parentBuild, judge };
}

test("a proven revert with its culprit's parent's build is judged against that parent", () => {
  const r = repo();
  assert.deepEqual(r.judge(), { culprit: r.culprit, parent: r.git('rev-parse', `${r.culprit}^`) });
});

test('planted (a) and (b): an ordinary pull request, and a revert branch the proof refuses, are judged as any pull request', () => {
  const r = repo();
  const c = REPLAY[0];
  const refused = [
    ['an ordinary pull request (no revert branch, a person)', { PR_HEAD_REF: 'fix/buy', PR_AUTHOR: 'someone', PR_AUTHOR_TYPE: 'User' }],
    ['a human author on the revert branch', { PR_AUTHOR: 'someone', PR_AUTHOR_TYPE: 'User' }],
    ['the App name, but a User', { PR_AUTHOR_TYPE: 'User' }],
    ['two commits', { PR_COMMITS: '2' }],
    ['a fork', { PR_HEAD_REPO: 'fork/r' }],
  ];
  for (const [why, over] of refused) {
    const got = r.judge(over);
    assert.equal(got.culprit, undefined, why);
    assert.equal(decide({ ...c, revert: got }).mode, 'block', `${why}: the recorded findings still block`);
  }
  // The revert plus one more change, in its one commit.
  r.write('apps/customer/src/screens/buy/Buy.tsx', 'export const Buy = () => <button className="fainter">Enter an amount</button>;\n');
  r.git('commit', '-q', '--no-verify', '--amend', '--no-edit', '-a');
  const extra = r.judge();
  assert.equal(extra.culprit, undefined, 'a revert plus one more change');
  assert.equal(decide({ ...c, revert: extra }).mode, 'block');
});

test("a proven revert whose parent build is not the culprit's parent, or is missing, is judged as any pull request", () => {
  const r = repo();
  writeFileSync(join(r.parentBuild, BUILT_FROM), `${r.git('rev-parse', 'origin/main')}\n`);
  assert.match(r.judge().why, /not [0-9a-f]{10}/);
  assert.match(r.judge({}, mkdtempSync(join(tmpdir(), 'look-revert-empty-'))).why, /missing/);
  assert.match(r.judge({}, null).why, /missing/);
});
