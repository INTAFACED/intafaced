// Run: node tooling/scripts/adr-index.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAdr, readAdrs, renderIndex } from './adr-index.mjs';

// plain status line
assert.deepEqual(parseAdr('2026-10-14-a.md', '# ADR: Keep it\n\n**Status:** accepted  \n'), {
  file: '2026-10-14-a.md',
  title: 'Keep it',
  status: 'accepted',
  date: '2026-10-14',
});
// "ADR —" prefix is dropped, a plain title is kept, keyword is case-insensitive
assert.equal(parseAdr('2026-08-08-b.md', '# ADR — Fail-closed oracle\n**Status:** Proposed\n').title, 'Fail-closed oracle');
assert.equal(parseAdr('2026-08-08-b.md', '# We will do X\n**Status:** Proposed\n').title, 'We will do X');
// superseded keeps only the keyword
assert.equal(parseAdr('2026-08-08-b.md', '# T\n**Status:** superseded by [x](y.md)\n').status, 'superseded');
// table form
assert.equal(parseAdr('2026-07-27-c.md', '# ADR: T\n\n| **Status**  | accepted     |\n| **Date** | x |\n').status, 'accepted');
// first status line wins, later addenda are ignored
assert.equal(parseAdr('2026-08-07-d.md', '# T\n**Status:** accepted\n\n**Status:** proposed\n').status, 'accepted');
// unreadable status, missing status, missing title and bad file name all refuse
assert.throws(() => parseAdr('2026-10-14-e.md', '# T\n**Status:** Assessment.\n'), /e\.md: status must start with/);
assert.throws(() => parseAdr('2026-10-14-e.md', '# T\nno status\n'), /no "\*\*Status:\*\*" line/);
assert.throws(() => parseAdr('2026-10-14-e.md', '**Status:** accepted\n'), /no "# " title/);
assert.throws(() => parseAdr('notes.md', '# T\n**Status:** accepted\n'), /must start with YYYY-MM-DD-/);

// directory read: newest first, TEMPLATE and README skipped, every problem reported at once
const dir = mkdtempSync(join(tmpdir(), 'adr-index-'));
try {
  assert.deepEqual(readAdrs(join(dir, 'missing')), []);
  writeFileSync(join(dir, '2026-01-01-old.md'), '# Old | pipe\n**Status:** accepted\n');
  writeFileSync(join(dir, '2026-02-01-new.md'), '# New\n**Status:** proposed\n');
  writeFileSync(join(dir, 'TEMPLATE.md'), '# T\n**Status:** proposed | accepted | superseded\n');
  writeFileSync(join(dir, 'README.md'), '# index\n');
  const rows = readAdrs(dir);
  assert.deepEqual(
    rows.map((r) => r.file),
    ['2026-02-01-new.md', '2026-01-01-old.md'],
  );
  const md = renderIndex(rows);
  assert.match(md, /2 records: 1 accepted, 1 proposed, 0 superseded\./);
  assert.match(md, /\| Old \\\| pipe \| accepted \| 2026-01-01 \| \[2026-01-01-old\.md\]\(2026-01-01-old\.md\) \|/);
  assert.equal(renderIndex(rows), md, 'rendering is deterministic');

  writeFileSync(join(dir, '2026-03-01-bad1.md'), '# B1\n**Status:** maybe\n');
  writeFileSync(join(dir, '2026-03-02-bad2.md'), '# B2\n');
  assert.throws(
    () => readAdrs(dir),
    (e) => /bad1\.md/.test(e.message) && /bad2\.md/.test(e.message),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('adr-index tests OK');
