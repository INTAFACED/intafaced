// exact-revert: the diff-only proof (exactReverse) on fixtures, and the git proof (revertTreeMatches) in a real repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exactReverse, revertTreeMatches } from './exact-revert.mjs';

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

test('exactReverse: the revert undoes every hunk', () => {
  assert.equal(exactReverse(revert, culprit), true);
});

test("exactReverse: context changed around it can't be told from the diff alone (revertTreeMatches can)", () => {
  // A later merge added a line beside the culprit's, so a context line and the hunks' places differ.
  const moved = revert
    .replace('@@ -3,7 +3,6 @@ x\n import a;', '@@ -4,7 +4,6 @@ x\n import z;')
    .replace('@@ -41,5 +40,4 @@', '@@ -43,5 +42,4 @@');
  assert.equal(exactReverse(moved, culprit), false);
});

test('exactReverse: planted faults, anything that is not the undo of a changed line', () => {
  assert.equal(
    exactReverse(revert.replace('-expect(d).toBe(1n);', '-expect(d).toBeTruthy();'), culprit),
    false,
    'a changed line that differs',
  );
  assert.equal(
    exactReverse(revert.replace(' j();\n k();', ' j();\n-k();'), culprit),
    false,
    'one more line removed (a context line turned into a change)',
  );
  assert.equal(exactReverse(revert.replace(' i();\n-expect', ' i();\n+evil();\n-expect'), culprit), false, 'a line added');
  assert.equal(exactReverse(revert.slice(0, revert.indexOf('diff --git a/t.test.ts')), culprit), false, 'a file left out');
  assert.equal(
    exactReverse(`${revert}diff --git a/z.ts b/z.ts\n--- a/z.ts\n+++ b/z.ts\n@@ -1 +1 @@\n-a\n+b\n`, culprit),
    false,
    'a file added',
  );
  assert.equal(exactReverse(revert.replace('@@ -41,5 +40,4 @@', '@@ -2,5 +1,4 @@'), culprit), false, 'hunks out of order');
  assert.equal(exactReverse(culprit, culprit), false, 'the commit itself is not its revert');
  assert.equal(exactReverse('diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n', culprit), false, 'a binary file');
});

test('revertTreeMatches: in a real repository, a revert with main changed beside it, and a hand-made one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exact-revert-'));
  try {
    const g = (...args) =>
      execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const put = (text) => writeFileSync(join(dir, 'a.mjs'), `${text.join('\n')}\n`);
    const lines = ['import a;', 'import b;', 'import c;', '', "test('#1', () => {", '  x();', '});', "test('#7', () => {", '  x();', '});'];
    g('init', '-q');
    put(lines);
    g('add', '.');
    g('commit', '-qm', 'base');
    put([
      ...lines.slice(0, 3),
      'import d;',
      ...lines.slice(3, 6),
      '  expect(x).toBe(1n);',
      ...lines.slice(6, 9),
      '  expect(x).toBe(1n);',
      ...lines.slice(9),
    ]);
    g('commit', '-qam', 'culprit');
    const culpritSha = g('rev-parse', 'HEAD').trim();
    const later = [
      lines[0],
      'import e;',
      ...lines.slice(1, 3),
      'import d;',
      ...lines.slice(3, 6),
      '  expect(x).toBe(1n);',
      ...lines.slice(6, 9),
      '  expect(x).toBe(1n);',
      ...lines.slice(9),
    ];
    put(later);
    g('commit', '-qam', 'a later merge beside it');
    const mainSha = g('rev-parse', 'HEAD').trim();
    g('revert', '--no-edit', culpritSha);
    const read = (args) => g(...args);
    assert.equal(
      revertTreeMatches(read, { culprit: culpritSha, head: g('rev-parse', 'HEAD').trim() }),
      true,
      "git's own revert, with main changed beside it",
    );
    g('reset', '-q', '--hard', mainSha);
    put(later.filter((l, k) => l !== 'import d;' && k !== later.lastIndexOf('  expect(x).toBe(1n);')));
    g('commit', '-qam', 'by hand: the same line removed from another test');
    assert.equal(
      revertTreeMatches(read, { culprit: culpritSha, head: g('rev-parse', 'HEAD').trim() }),
      false,
      'planted fault: the line removed under the second test, not the first',
    );
    assert.equal(revertTreeMatches(read, { culprit: culpritSha, head: mainSha }), false, 'a commit that is no revert');
    assert.equal(revertTreeMatches(read, { culprit: 'f'.repeat(40), head: mainSha }), false, 'an unknown culprit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
