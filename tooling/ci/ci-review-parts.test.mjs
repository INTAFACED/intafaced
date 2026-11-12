// The CI review in parts, the empty diff, and main-bisect's automatic revert (ci-review.mjs splitDiff, readVerdicts,
// readableDiff, exactReverse, automaticRevert). Failure they prevent: of 85 CI review FAILs from 10 to 12 Nov 2026, 24
// were the 400,000-byte cap alone, 3 an empty diff and 1 main-bisect's own revert (project-state #2065).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  splitDiff,
  partNote,
  writeReviewInputs,
  readVerdicts,
  readableDiff,
  exactReverse,
  automaticRevert,
  revertNote,
  MAX_DIFF_BYTES,
  MAX_PARTS,
  VERDICT_SCHEMA,
  REVERT_AUTHOR,
} from './ci-review.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const CULPRIT = 'c'.repeat(40);
const tmp = () => mkdtempSync(join(tmpdir(), 'ci-review-parts-'));
const briefs = {
  reviewBrief: readFileSync(new URL('./ci-review/REVIEW.md', import.meta.url), 'utf8'),
  testsBrief: readFileSync(new URL('./test-judge/JUDGE.md', import.meta.url), 'utf8'),
};
const never = async () => assert.fail('no step words are read for a change no test part applies to');
const file = (path, lines, sign = '+') =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `${sign}${l}`).join('\n')}\n`;
const bulk = (n, tag) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = '${'x'.repeat(60)}';`);
// Three product files of about 180 KB each: about 540 KB, like #7728's heads over the cap.
const BIG = ['services/svc-a/src/a.ts', 'services/svc-a/src/b.ts', 'services/svc-b/src/c.ts']
  .map((p, i) => file(p, bulk(2_200, `v${i}_`)))
  .join('');
const answer = (structured) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: structured });
const srcOf = (diff) => ({ diff: async () => ({ diff, mergeBase: BASE }) });

test('a diff over the cap splits between files, in order, with nothing cut or left out', () => {
  assert.ok(Buffer.byteLength(BIG) > MAX_DIFF_BYTES);
  const { parts, tooLarge } = splitDiff(BIG);
  assert.equal(tooLarge, undefined);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(''), BIG, 'the parts, joined, are the diff byte for byte');
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= MAX_DIFF_BYTES);
  // A diff that fits is one part, itself.
  assert.deepEqual(splitDiff(file('a.ts', ['x'])).parts, [file('a.ts', ['x'])]);
});

test('a file over the cap splits between its hunks, each under its file header; one hunk over it is too large', () => {
  const header = 'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n';
  const hunk = (at, n) =>
    `@@ -${at},0 +${at},${n} @@\n${bulk(n, `h${at}_`)
      .map((l) => `+${l}`)
      .join('\n')}\n`;
  const hunks = [hunk(1, 2_500), hunk(5_000, 2_500), hunk(10_000, 2_500)];
  const one = header + hunks.join('');
  assert.ok(Buffer.byteLength(one) > MAX_DIFF_BYTES);
  const { parts } = splitDiff(one);
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.startsWith(header), 'every part carries the file header');
    assert.ok(Buffer.byteLength(p) <= MAX_DIFF_BYTES);
  }
  assert.equal(parts.map((p) => p.slice(header.length)).join(''), hunks.join(''), 'every hunk once, in order');
  // Planted: one hunk alone over the cap, a large file with no hunk, and more parts than MAX_PARTS.
  assert.match(splitDiff(header + hunk(1, 8_000)).tooLarge, /one hunk of big\.ts is \d+ bytes, over 400000/);
  assert.match(splitDiff(`diff --git a/x.bin b/x.bin\n${'Binary junk\n'.repeat(40_000)}`).tooLarge, /no hunk to split at/);
  const many = Array.from({ length: MAX_PARTS + 1 }, (_, i) => file(`f${i}.ts`, bulk(4_500, `m${i}_`))).join('');
  assert.match(splitDiff(many).tooLarge, new RegExp(`it takes ${MAX_PARTS + 1} parts .* over ${MAX_PARTS}`));
});

test('the review in parts: one prompt per part with the note, and the review FAILs when any part does', async () => {
  const dir = tmp();
  const said = await writeReviewInputs(dir, { diff: BIG, base: BASE, head: HEAD, pr: 7, src: srcOf(BIG), loadWords: never, ...briefs });
  assert.match(said, /reviewed in 2 parts/);
  assert.ok(!existsSync(join(dir, 'skip-reviewer')), 'the reviewer is asked');
  assert.deepEqual(readdirSync(join(dir, 'parts')), ['2']);
  const first = readFileSync(join(dir, 'prompt.txt'), 'utf8');
  const second = readFileSync(join(dir, 'parts', '2', 'prompt.txt'), 'utf8');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'parts', '2', 'schema.json'), 'utf8')), VERDICT_SCHEMA);
  const { parts } = splitDiff(BIG);
  assert.ok(first.includes(partNote(parts, 1, Buffer.byteLength(BIG))) && second.includes(partNote(parts, 2, Buffer.byteLength(BIG))));
  // The note sits above the fence, from the code; every file is named, and each part's diff is inside its own fence.
  for (const [p, k] of [
    [first, 0],
    [second, 1],
  ]) {
    assert.ok(p.indexOf('This is part') < p.indexOf('\nBEGIN UNTRUSTED DIFF\n'));
    assert.ok(p.includes(`BEGIN UNTRUSTED DIFF\n${parts[k]}\nEND UNTRUSTED DIFF`));
    for (const f of ['services/svc-a/src/a.ts', 'services/svc-a/src/b.ts', 'services/svc-b/src/c.ts']) assert.ok(p.includes(f));
  }
  const pass = answer({ verdict: 'PASS', findings: ['note: fine'] });
  const fail = answer({ verdict: 'FAIL', findings: ['services/svc-b/src/c.ts:3: item 1: money in a number'] });
  // Both parts pass: PASS.
  writeFileSync(join(dir, 'answer.json'), pass);
  writeFileSync(join(dir, 'parts', '2', 'answer.json'), pass);
  assert.equal(readVerdicts(dir).ok, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')).verdict, 'PASS');
  // Either part fails: FAIL, with that part's finding.
  for (const [a, b] of [
    [pass, fail],
    [fail, pass],
  ]) {
    writeFileSync(join(dir, 'answer.json'), a);
    writeFileSync(join(dir, 'parts', '2', 'answer.json'), b);
    assert.equal(readVerdicts(dir).ok, true);
    const v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
    assert.equal(v.verdict, 'FAIL');
    assert.ok(v.findings.includes('services/svc-b/src/c.ts:3: item 1: money in a number'));
  }
  // Fails closed: a part with no answer, or one that isn't a verdict, is no verdict at all.
  writeFileSync(join(dir, 'answer.json'), pass);
  writeFileSync(join(dir, 'parts', '2', 'answer.json'), 'not json');
  assert.equal(readVerdicts(dir).ok, false);
  writeFileSync(
    join(dir, 'parts', '2', 'answer.json'),
    answer({ verdict: 'PASS', findings: [] }).replace('"is_error":false', '"is_error":true'),
  );
  assert.equal(readVerdicts(dir).ok, false);
  const missing = tmp();
  await writeReviewInputs(missing, { diff: BIG, base: BASE, head: HEAD, pr: 7, src: srcOf(BIG), loadWords: never, ...briefs });
  writeFileSync(join(missing, 'answer.json'), pass);
  assert.match(readVerdicts(missing).why, /no answer\.json for part 2/);
});

test('still a FAIL without the reviewer: a diff that cannot be parted', async () => {
  const dir = tmp();
  const huge = `diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1,0 +1,1 @@\n+${'x'.repeat(MAX_DIFF_BYTES + 10)}\n`;
  await writeReviewInputs(dir, { diff: huge, base: BASE, head: HEAD, pr: 7, src: srcOf(huge), loadWords: never, ...briefs });
  assert.ok(existsSync(join(dir, 'skip-reviewer')));
  const v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.findings[0], /can't be reviewed in parts .*one hunk of one\.ts.*can't be reviewed whole/);
  assert.equal(readVerdicts(dir).ok, true);
});

test('an empty diff is no verdict, never a FAIL', () => {
  for (const empty of ['', '\n', '  \n'])
    assert.throws(() => readableDiff(empty, { base: BASE, head: HEAD }), /is empty: nothing to review, so no verdict/);
  assert.equal(readableDiff('diff --git a/x b/x\n', { base: BASE, head: HEAD }), 'diff --git a/x b/x\n');
});

// main-bisect's automatic revert: the culprit's diff and its exact reverse.
const CULPRIT_DIFF = [
  'diff --git a/apps/customer/tests/real-app/J-x-01.pw.mjs b/apps/customer/tests/real-app/J-x-01.pw.mjs',
  'index 1..2 100644',
  '--- a/apps/customer/tests/real-app/J-x-01.pw.mjs',
  '+++ b/apps/customer/tests/real-app/J-x-01.pw.mjs',
  '@@ -6,3 +6,3 @@',
  ' test(`${J} #2 sees`, async () => {',
  '-  expect(a).toBe(1n);',
  '+  expect(a).toBe(cents(1));',
  ' });',
  'diff --git a/docs/new.md b/docs/new.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/new.md',
  '@@ -0,0 +1 @@',
  '+hello',
  '',
].join('\n');
const REVERT_DIFF = [
  'diff --git a/apps/customer/tests/real-app/J-x-01.pw.mjs b/apps/customer/tests/real-app/J-x-01.pw.mjs',
  'index 2..1 100644',
  '--- a/apps/customer/tests/real-app/J-x-01.pw.mjs',
  '+++ b/apps/customer/tests/real-app/J-x-01.pw.mjs',
  '@@ -9,3 +9,3 @@',
  ' test(`${J} #2 sees`, async () => {',
  '-  expect(a).toBe(cents(1));',
  '+  expect(a).toBe(1n);',
  ' });',
  'diff --git a/docs/new.md b/docs/new.md',
  'deleted file mode 100644',
  '--- a/docs/new.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-hello',
  '',
].join('\n');

test('exactReverse: the same lines the other way in every file, and nothing else', () => {
  assert.equal(exactReverse(REVERT_DIFF, CULPRIT_DIFF), true);
  // Planted: a line changed by hand, a file left out, a file added, the same direction, and a binary file.
  assert.equal(exactReverse(REVERT_DIFF.replace('+  expect(a).toBe(1n);', '+  expect(a).toBeTruthy();'), CULPRIT_DIFF), false);
  assert.equal(exactReverse(REVERT_DIFF.slice(0, REVERT_DIFF.indexOf('diff --git a/docs')), CULPRIT_DIFF), false);
  assert.equal(exactReverse(`${REVERT_DIFF}diff --git a/z.ts b/z.ts\n--- a/z.ts\n+++ b/z.ts\n@@ -1 +1 @@\n-a\n+b\n`, CULPRIT_DIFF), false);
  assert.equal(exactReverse(CULPRIT_DIFF, CULPRIT_DIFF), false);
  const bin = 'diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n';
  assert.equal(exactReverse(REVERT_DIFF + bin, CULPRIT_DIFF + bin), false);
  assert.equal(exactReverse('', ''), false);
});

const revertApi = (over = {}) => {
  const asked = [];
  const get = async (p, accept) => {
    asked.push(p);
    if (p === `/repos/o/r/commits/${HEAD}`)
      return {
        status: 200,
        text: JSON.stringify(
          over.commit ?? { commit: { message: `Revert "x"\n\nThis reverts commit ${CULPRIT}.` }, parents: [{ sha: BASE }] },
        ),
      };
    if (p === `/repos/o/r/compare/${CULPRIT}...${BASE}`) return { status: 200, text: JSON.stringify({ status: over.status ?? 'ahead' }) };
    if (p === `/repos/o/r/commits/${CULPRIT}` && accept === 'application/vnd.github.v3.diff')
      return { status: over.diffStatus ?? 200, text: CULPRIT_DIFF };
    return { status: 404, text: '' };
  };
  return { get, asked };
};
const PULL = { head: HEAD, base: BASE, user: REVERT_AUTHOR, ref: 'revert/auto-cccccccccc' };

test("automaticRevert: only main-bisect's own revert, exactly the reverse of a commit main contains", async () => {
  assert.equal(await automaticRevert({ repo: 'o/r', pull: PULL, diff: REVERT_DIFF, get: revertApi().get }), CULPRIT);
  assert.equal(await automaticRevert({ repo: 'o/r', pull: PULL, diff: REVERT_DIFF, get: revertApi({ status: 'identical' }).get }), CULPRIT);
  const none = async (pull, diff, over) => assert.equal(await automaticRevert({ repo: 'o/r', pull, diff, get: revertApi(over).get }), null);
  // Planted: another author, another branch, a hand edit, a culprit main doesn't contain, an unreadable culprit, a
  // commit that names no culprit, and a merge commit.
  const api = revertApi();
  await automaticRevert({ repo: 'o/r', pull: { ...PULL, user: 'ZenYoda3' }, diff: REVERT_DIFF, get: api.get });
  assert.equal(api.asked.length, 0, 'another author is never read further');
  await none({ ...PULL, user: 'ZenYoda3' }, REVERT_DIFF);
  await none({ ...PULL, ref: 'fix/revert' }, REVERT_DIFF);
  await none(PULL, REVERT_DIFF.replace('+  expect(a).toBe(1n);', '+  expect(a).toBeTruthy();'));
  await none(PULL, REVERT_DIFF, { status: 'diverged' });
  await none(PULL, REVERT_DIFF, { diffStatus: 404 });
  await none(PULL, REVERT_DIFF, { commit: { commit: { message: 'Revert "x"' }, parents: [{ sha: BASE }] } });
  await none(PULL, REVERT_DIFF, {
    commit: { commit: { message: `This reverts commit ${CULPRIT}.` }, parents: [{ sha: BASE }, { sha: CULPRIT }] },
  });
});

test('an automatic revert: the reviewer is told the checked fact, and the test part passes without the call', async () => {
  const dir = tmp();
  await writeReviewInputs(dir, {
    diff: REVERT_DIFF,
    base: BASE,
    head: HEAD,
    pr: 7,
    src: srcOf(REVERT_DIFF),
    loadWords: never,
    ...briefs,
    revertOf: CULPRIT,
  });
  const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
  assert.ok(prompt.indexOf(revertNote(CULPRIT)) > 0 && prompt.indexOf(revertNote(CULPRIT)) < prompt.indexOf('\nBEGIN UNTRUSTED DIFF\n'));
  assert.ok(!existsSync(join(dir, 'combined')), 'the review alone is asked');
  const t = JSON.parse(readFileSync(join(dir, 'tests', 'verdict.json'), 'utf8'));
  assert.equal(t.verdict, 'PASS');
  assert.match(t.findings[0], new RegExp(`exact revert of ${CULPRIT}`));
  // The review part is still the reviewer's: its FAIL stands.
  writeFileSync(join(dir, 'answer.json'), answer({ verdict: 'FAIL', findings: ['x.ts:1: item 2: a secret'] }));
  assert.equal(readVerdicts(dir).ok, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')).verdict, 'FAIL');
  // Without the fact, the same diff goes to the test part as any other.
  const plain = tmp();
  let read = 0;
  await writeReviewInputs(plain, {
    diff: REVERT_DIFF,
    base: BASE,
    head: HEAD,
    pr: 7,
    src: { ...srcOf(REVERT_DIFF), read: async () => null, journeys: async () => [], readGraph: () => null },
    loadWords: async () => (read++, { words: new Map(), ref: 'r' }),
    ...briefs,
  });
  assert.doesNotMatch(readFileSync(join(plain, 'prompt.txt'), 'utf8'), /automaticRevert/);
  assert.ok(read > 0 || existsSync(join(plain, 'tests', 'meta.json')), 'the test part judged it');
});
