/**
 * EXACT REVERT: whether a pull request undoes one commit and does nothing else. No imports, so main's copy of the
 * test-diff guard can take it beside itself (ci.yml), and the CI review (ci-review.mjs automaticRevert) reads the same
 * rules. Two proofs, either enough:
 *   exactReverse        the diff alone: every hunk of the commit undone, context lines included, moved together.
 *   revertTreeMatches   git: the head is exactly `git revert <commit>` made on its own parent (same tree, no conflict),
 *                       which still holds when main changed the lines around the commit since it merged (intafaced
 *                       #8138: #8117 added an import beside #8113's, so the revert's context lines read differently).
 * A line changed by hand fails both.
 *
 *   node tooling/ci/exact-revert.mjs --self-test
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Each file's hunks, keyed `old\0new`: [{ oldStart, newStart, lines }], a `\ No newline` marker kept on its line.
 *  Null when a section is binary or a file repeats. */
export function hunksOf(diff) {
  const out = new Map();
  const sections = String(diff ?? '')
    .split(/^(?=diff --git )/m)
    .filter((s) => s.startsWith('diff --git '));
  for (const s of sections) {
    if (/^Binary files |^GIT binary patch$/m.test(s)) return null;
    const path = (re) => {
      const m = re.exec(s)?.[1];
      return m === undefined || m === '/dev/null' ? null : m.replace(/^[ab]\//, '');
    };
    const head = /^diff --git a\/(.+) b\/(.+)$/m.exec(s);
    const oldPath = /^--- /m.test(s) ? path(/^--- (.+)$/m) : head?.[1] ?? null;
    const newPath = /^\+\+\+ /m.test(s) ? path(/^\+\+\+ (.+)$/m) : head?.[2] ?? null;
    const key = `${oldPath}\0${newPath}`;
    if (out.has(key)) return null;
    const hunks = [];
    let inHunk = false;
    for (const line of s.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) {
        hunks.push({ oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] });
        inHunk = true;
      } else if (inHunk && line.startsWith('\\')) hunks.at(-1).lines.push(`${hunks.at(-1).lines.pop() ?? ''}\n${line}`);
      else if (inHunk && /^[ +-]/.test(line)) hunks.at(-1).lines.push(line);
    }
    out.set(key, hunks);
  }
  return out;
}

/** A hunk's lines undone: + and - swapped, each run of changes written as git writes it, its - lines before its + lines. */
export function undo(lines) {
  const out = [];
  let minus = [];
  let plus = [];
  const flush = () => (out.push(...minus, ...plus), (minus = []), (plus = []));
  for (const l of lines) {
    if (l.startsWith('+')) minus.push(`-${l.slice(1)}`);
    else if (l.startsWith('-')) plus.push(`+${l.slice(1)}`);
    else (flush(), out.push(l));
  }
  flush();
  return out;
}

/**
 * Whether `diff` is exactly the reverse of `culpritDiff`: the same files, each with the same hunks undone, context lines
 * and order included, every hunk of a file moved by one and the same number of lines (main may have moved on above it).
 * Any binary file, or any other difference: false.
 */
export function exactReverse(diff, culpritDiff) {
  const a = hunksOf(diff);
  const b = hunksOf(culpritDiff);
  if (!a || !b || a.size === 0 || a.size !== b.size) return false;
  for (const [key, ch] of b) {
    const [oldPath, newPath] = key.split('\0');
    const rh = a.get(`${newPath}\0${oldPath}`);
    if (!rh || rh.length !== ch.length) return false;
    const shift = rh.length ? rh[0].oldStart - ch[0].newStart : 0;
    for (let i = 0; i < ch.length; i++) {
      if (rh[i].oldStart - ch[i].newStart !== shift || rh[i].newStart - ch[i].oldStart !== shift) return false;
      const want = undo(ch[i].lines);
      if (want.length !== rh[i].lines.length || want.some((l, k) => l !== rh[i].lines[k])) return false;
    }
  }
  return true;
}

/**
 * Whether commit `head` is exactly `git revert <culprit>` made on head's own parent: git's three-way merge of the
 * culprit's parent onto head's parent, with the culprit as the base (what `git revert` does), gives head's tree, with no
 * conflict. This holds when main changed the lines around the culprit since it merged, where exactReverse's diff
 * reading can't (intafaced #8138: #8117 had added an import beside #8113's, so git's revert wrote other context lines),
 * and it fails for any line changed by hand. `read(args)`: git's output, throwing on a failure (a conflict included).
 * The commits must be in the repository: head, its parent, the culprit and its parent.
 */
export function revertTreeMatches(read, { culprit, head }) {
  try {
    const parents = read(['rev-list', '--parents', '-n', '1', head]).trim().split(' ');
    const cParents = read(['rev-list', '--parents', '-n', '1', culprit]).trim().split(' ');
    if (parents.length !== 2 || cParents.length !== 2) return false;
    const tree = read(['merge-tree', '--write-tree', `--merge-base=${culprit}`, parents[1], cParents[1]]).trim().split('\n')[0];
    return /^[0-9a-f]{40}$/.test(tree) && tree === read(['rev-parse', `${head}^{tree}`]).trim();
  } catch {
    return false;
  }
}

/** main-bisect's revert: its branch, the App that opens it, and the line its one commit carries (journeys-revert.mjs). */
export const AUTO_REVERT_BRANCH = /^revert\/auto-([0-9a-f]{10})$/;
export const AUTO_REVERT_AUTHOR = 'intafaced-mac-agents[bot]';
export const REVERTS_COMMIT = /^This reverts commit ([0-9a-f]{40})\.$/m;

function selfTest() {
  const eq = (got, want, m) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${m}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  };
  const culprit = [
    'diff --git a/a.ts b/a.ts',
    'index 1..2 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -3,6 +3,7 @@ x',
    ' import a;',
    ' import b;',
    ' import c;',
    '+import d;',
    ' ',
    ' f();',
    ' g();',
    '@@ -40,4 +41,5 @@ y',
    ' h();',
    ' i();',
    '+expect(d).toBe(1n);',
    ' j();',
    ' k();',
    'diff --git a/t.test.ts b/t.test.ts',
    'new file mode 100644',
    'index 0..3',
    '--- /dev/null',
    '+++ b/t.test.ts',
    '@@ -0,0 +1,2 @@',
    "+test('d', () => {",
    '+});',
    '',
  ].join('\n');
  const revert = [
    'diff --git a/a.ts b/a.ts',
    'index 2..1 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -3,7 +3,6 @@ x',
    ' import a;',
    ' import b;',
    ' import c;',
    '-import d;',
    ' ',
    ' f();',
    ' g();',
    '@@ -41,5 +40,4 @@ y',
    ' h();',
    ' i();',
    '-expect(d).toBe(1n);',
    ' j();',
    ' k();',
    'diff --git a/t.test.ts b/t.test.ts',
    'deleted file mode 100644',
    'index 3..0',
    '--- a/t.test.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    "-test('d', () => {",
    '-});',
    '',
  ].join('\n');
  eq(exactReverse(revert, culprit), true, 'the revert undoes every hunk');
  // #8138: a later merge added a line beside the culprit's, so a context line and the hunks' places differ.
  const moved = revert.replace('@@ -3,7 +3,6 @@ x\n import a;', '@@ -4,7 +4,6 @@ x\n import z;').replace('@@ -41,5 +40,4 @@', '@@ -43,5 +42,4 @@');
  eq(exactReverse(moved, culprit), false, 'context changed around it: the diff alone can\'t tell (revertTreeMatches can)');
  // Planted faults: anything that is not the undo of a changed line.
  eq(exactReverse(revert.replace('-expect(d).toBe(1n);', '-expect(d).toBeTruthy();'), culprit), false, 'a changed line that differs');
  eq(exactReverse(revert.replace(' j();\n k();', ' j();\n-k();'), culprit), false, 'one more line removed (a context line turned into a change)');
  eq(exactReverse(revert.replace(" i();\n-expect", " i();\n+evil();\n-expect"), culprit), false, 'a line added');
  eq(exactReverse(revert.slice(0, revert.indexOf('diff --git a/t.test.ts')), culprit), false, 'a file left out');
  eq(exactReverse(`${revert}diff --git a/z.ts b/z.ts\n--- a/z.ts\n+++ b/z.ts\n@@ -1 +1 @@\n-a\n+b\n`, culprit), false, 'a file added');
  eq(exactReverse(revert.replace('@@ -41,5 +40,4 @@', '@@ -2,5 +1,4 @@'), culprit), false, 'hunks out of order');
  eq(exactReverse(culprit, culprit), false, 'the commit itself is not its revert');
  eq(exactReverse('diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n', culprit), false, 'a binary file');
  // revertTreeMatches, in a real repository: #8138's case, then a hand-made "revert" that removes the same line elsewhere.
  const dir = mkdtempSync(join(tmpdir(), 'exact-revert-'));
  try {
    const g = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const put = (text) => writeFileSync(join(dir, 'a.mjs'), `${text.join('\n')}\n`);
    const lines = ['import a;', 'import b;', 'import c;', '', "test('#1', () => {", '  x();', '});', "test('#7', () => {", '  x();', '});'];
    g('init', '-q');
    put(lines);
    g('add', '.');
    g('commit', '-qm', 'base');
    put([...lines.slice(0, 3), 'import d;', ...lines.slice(3, 6), '  expect(x).toBe(1n);', ...lines.slice(6, 9), '  expect(x).toBe(1n);', ...lines.slice(9)]);
    g('commit', '-qam', 'culprit');
    const culpritSha = g('rev-parse', 'HEAD').trim();
    const later = [lines[0], 'import e;', ...lines.slice(1, 3), 'import d;', ...lines.slice(3, 6), '  expect(x).toBe(1n);', ...lines.slice(6, 9), '  expect(x).toBe(1n);', ...lines.slice(9)];
    put(later);
    g('commit', '-qam', 'a later merge beside it');
    const mainSha = g('rev-parse', 'HEAD').trim();
    g('revert', '--no-edit', culpritSha);
    const read = (args) => g(...args);
    eq(revertTreeMatches(read, { culprit: culpritSha, head: g('rev-parse', 'HEAD').trim() }), true, "git's own revert, with main changed beside it");
    g('reset', '-q', '--hard', mainSha);
    put(later.filter((l, k) => l !== 'import d;' && k !== later.lastIndexOf('  expect(x).toBe(1n);')));
    g('commit', '-qam', 'by hand: the same line removed from another test');
    eq(revertTreeMatches(read, { culprit: culpritSha, head: g('rev-parse', 'HEAD').trim() }), false, 'planted fault: the line removed under #7, not #1');
    eq(revertTreeMatches(read, { culprit: culpritSha, head: mainSha }), false, 'a commit that is no revert');
    eq(revertTreeMatches(read, { culprit: 'f'.repeat(40), head: mainSha }), false, 'an unknown culprit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('✓ exact-revert --self-test OK (14 fixtures)');
}

if (process.argv.includes('--self-test') && process.argv[1]?.endsWith('exact-revert.mjs')) selfTest();
