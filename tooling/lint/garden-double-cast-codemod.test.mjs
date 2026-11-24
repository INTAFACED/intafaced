import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, newErrors, parseTsc, planSite } from './garden-double-cast-codemod.mjs';

/** The span oxlint reports for the outer cast: from the start of `from` to the end of the first `to` after it. */
const span = (src, from, to) => {
  const bytes = Buffer.from(src, 'utf8');
  const start = bytes.indexOf(from);
  const end = bytes.indexOf(to, start) + Buffer.byteLength(to);
  return { bytes, offset: start, length: end - start };
};
const rewrite = (src, from, to) => {
  const s = span(src, from, to);
  const plan = planSite(s.bytes, s.offset, s.length);
  return plan.skip ? plan : apply(s.bytes, [plan]).toString('utf8');
};

test('the outer `as unknown as T` becomes `as T`', () => {
  assert.equal(rewrite('return fake as unknown as AgentRuntime;\n', 'fake', 'AgentRuntime'), 'return fake as AgentRuntime;\n');
});

test('an object literal keeps its body', () => {
  const src = 'const x = {\n  a: 1,\n} as unknown as Thing;\n';
  assert.equal(rewrite(src, '{', 'Thing'), 'const x = {\n  a: 1,\n} as Thing;\n');
});

test('a nested double cast loses only the outer one', () => {
  const src = 'f((a as unknown as B) as unknown as C);\n';
  assert.equal(rewrite(src, '(a', 'C'), 'f((a as unknown as B) as C);\n');
});

test('spans count UTF-8 bytes, as oxlint does', () => {
  const src = "// déjà — vu\nconst y = z as unknown as Q<'é'>;\n";
  assert.equal(rewrite(src, 'z', "Q<'é'>"), "// déjà — vu\nconst y = z as Q<'é'>;\n");
});

test('a cast that spans lines is left', () => {
  assert.deepEqual(rewrite('const y = z as unknown\n  as Q;\n', 'z', 'Q'), { skip: 'the cast spans lines' });
});

test('several sites in one file are applied last first', () => {
  const src = 'a as unknown as A; b as unknown as B;\n';
  const bytes = Buffer.from(src);
  const plans = [planSite(bytes, 0, 17), planSite(bytes, 19, 17)];
  assert.equal(apply(bytes, plans).toString(), 'a as A; b as B;\n');
});

test('tsc lines are parsed, and only errors beyond the baseline count as new', () => {
  const before = parseTsc("src/a.test.ts(3,5): error TS2322: Type 'x' is not assignable.\n");
  const after = parseTsc(
    "src/a.test.ts(4,5): error TS2322: Type 'x' is not assignable.\n" +
      'src/a.test.ts(9,1): error TS2352: Conversion of type may be a mistake.\n',
  );
  assert.deepEqual(
    newErrors(before, after).map((e) => [e.file, e.line, e.col, e.code]),
    [['src/a.test.ts', 9, 1, 'TS2352']],
  );
});
