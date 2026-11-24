// The classifier of tests that read source text: it finds the block a read sits in or feeds, refuses to delete a
// protected test or one whose guard does not exist, and deletes a guarded site's block, its read and its dead imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeletes, blocks, classify, closeOf, facts, guardError } from './classify.mjs';

const FILE = 'packages/venue-x/src/limit.test.ts';
const TEXT = [
  "import { readFileSync } from 'node:fs';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "import { describe, expect, it } from 'vitest';",
  "import { snapshot } from './x.js';",
  '',
  "describe('snapshot limit', () => {",
  "  it('x.ts does not default 100', () => {",
  "    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'x.ts'), 'utf8');",
  '    expect(src).toMatch(/limit_unset/);',
  "    expect(src).not.toMatch(/= '100'/);",
  '  });',
  '',
  "  it('a missing limit refuses', async () => {",
  "    await expect(snapshot('BTC', undefined)).rejects.toMatchObject({ code: 'limit_unset' });",
  '  });',
  '});',
  '',
].join('\n');
const SITE = { file: FILE, line: 9, target: 'x.ts' };
const read = (files) => (p) => files[p] ?? null;
const GUARD = { kind: 'test', ref: `${FILE}#a missing limit refuses` };

test('a bracket closes past strings, templates, comments and regex literals', () => {
  const t = "f(a, '(', `${g(')')}`, /\\)(/, // )\n b /* ) */)";
  assert.equal(closeOf(t, 1), t.length);
  assert.deepEqual(
    blocks(TEXT).map((b) => [b.title, b.from, b.to]),
    [
      ['x.ts does not default 100', 8, 12],
      ['a missing limit refuses', 14, 16],
    ],
  );
});

test('a site gets the block it sits in and what that block asserts; a module-level read gets every block using it', () => {
  const f = facts(SITE, TEXT);
  assert.deepEqual(
    f.blocks.map((b) => b.title),
    ['x.ts does not default 100'],
  );
  assert.deepEqual(f.asserts, ['expect(src).toMatch(/limit_unset/);', "expect(src).not.toMatch(/= '100'/);"]);
  assert.deepEqual(f.protectedAs, []);
  const top =
    "const SRC = readFileSync(join(ROOT, 'apps/a/src/b.ts'), 'utf8');\nit('one', () => { expect(SRC).toContain('x'); });\nit('two', () => { expect(1).toBe(1); });\n";
  assert.deepEqual(
    facts({ file: 'apps/a/src/b.test.ts', line: 1, target: 'b.ts' }, top).blocks.map((b) => b.title),
    ['one'],
  );
});

test('delete holds only with a guard that exists, and never for a protected test', () => {
  const files = { [FILE]: TEXT, '.oxlintrc.json': '{ "rules": { "garden/no-runtime-swap": "error" } }' };
  const ok = classify([SITE], read(files), [{ ...SITE, verdict: 'delete', guard: GUARD }]);
  assert.deepEqual(ok[0].problems, []);
  assert.match(guardError({ kind: 'test', ref: `${FILE}#a test nobody wrote` }, read(files)), /has no test titled/);
  assert.equal(guardError({ kind: 'lint', ref: 'garden/no-runtime-swap' }, read(files)), null);
  assert.match(guardError({ kind: 'lint', ref: 'garden/made-up' }, read(files)), /not on/);
  assert.deepEqual(classify([SITE], read(files), [])[0].problems, ['no verdict on record']);
  const session = TEXT.replace('x.ts does not default 100', 'the session cookie is signed');
  const refused = classify([SITE], read({ ...files, [FILE]: session }), [{ ...SITE, verdict: 'delete', guard: GUARD }]);
  assert.deepEqual(refused[0].protectedAs, ['sign-in']);
  assert.match(refused[0].problems.join(), /never deleted, only rewritten/);
});

test('apply deletes the block, the read and the imports nothing uses, and keeps the guard; a file left with no test goes', () => {
  const [row] = classify([SITE], read({ [FILE]: TEXT }), [{ ...SITE, verdict: 'delete', guard: GUARD }]);
  const out = applyDeletes(TEXT, [row]);
  assert.doesNotMatch(out, /readFileSync|fileURLToPath|dirname|does not default/);
  assert.match(out, /^import \{ describe, expect, it \} from 'vitest';$/m);
  assert.match(out, /it\('a missing limit refuses'/);
  assert.equal(applyDeletes(TEXT, [row, { ...row, blocks: [{ title: 'a missing limit refuses', from: 14 }] }]), null);
});
