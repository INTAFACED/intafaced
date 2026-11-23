// A file deleted whole reaching the CI review as one line pointing at the reviewer's own checkout (ci-review.mjs
// summarizeDeleted): only when the diff is over the cap and the checkout holds exactly the deleted text, else whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blobId, MAX_DIFF_BYTES, summarizeDeleted } from './ci-review.mjs';

const big = (n) =>
  Array.from({ length: n }, (_, i) => `export const line${i} = 'a line of the old service, about sixty bytes';`).join('\n') + '\n';
const deleted = (path, t) => {
  const ls = t.replace(/\n$/, '').split('\n');
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex ${blobId(t).slice(0, 10)}..0000000000\n--- a/${path}\n+++ /dev/null\n@@ -1,${ls.length} +0,0 @@\n${ls.map((l) => '-' + l).join('\n')}\n`;
};
const changed = 'diff --git a/x.ts b/x.ts\nindex 1111111111..2222222222 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n';

test('a file deleted whole, held exactly at its path in the checkout, becomes one line; the rest stays', () => {
  const t = big(8000);
  const diff = deleted('services/svc-old/src/a.ts', t) + changed;
  assert.ok(Buffer.byteLength(diff) > MAX_DIFF_BYTES);
  const out = summarizeDeleted(diff, (p) => (p === 'services/svc-old/src/a.ts' ? t : null));
  assert.ok(Buffer.byteLength(out) < 1000, 'the deletion is one line');
  assert.match(out, /^diff --git a\/services\/svc-old\/src\/a\.ts b\/services\/svc-old\/src\/a\.ts\ndeleted file mode 100644\nindex /);
  assert.match(out, /\[deleted whole: 8000 lines, \d+ bytes of diff; .* Read it there/);
  assert.ok(out.endsWith(changed), 'a changed file stays byte for byte');
});

test('planted: the checkout differs, lacks the file, or the diff is small: the deletion stays whole', () => {
  const t = big(8000);
  const diff = deleted('services/svc-old/src/a.ts', t) + changed;
  assert.equal(
    summarizeDeleted(diff, () => t.replace('line0 ', 'line0x ')),
    diff,
    'a checkout copy that differs',
  );
  assert.equal(
    summarizeDeleted(diff, () => null),
    diff,
    'no copy',
  );
  assert.equal(
    summarizeDeleted(diff, () => {
      throw new Error('ENOENT');
    }),
    diff,
    'an unreadable copy',
  );
  const small = deleted('a.ts', 'x\n') + changed;
  assert.equal(
    summarizeDeleted(small, () => 'x\n'),
    small,
    'under the cap nothing changes',
  );
  // A hunk that is not the whole old text (its index names another blob), and a rename, stay whole.
  const wrongIndex = diff.replace(/index [0-9a-f]{10}\.\./, 'index 0123456789..');
  assert.equal(
    summarizeDeleted(wrongIndex, () => t),
    wrongIndex,
  );
  const renamed = diff.replace(
    'diff --git a/services/svc-old/src/a.ts b/services/svc-old/src/a.ts',
    'diff --git a/services/svc-old/src/a.ts b/b.ts',
  );
  assert.equal(
    summarizeDeleted(renamed, () => t),
    renamed,
  );
});
