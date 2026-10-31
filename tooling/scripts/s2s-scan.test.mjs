/**
 * Unit tests for tooling/ci/s2s-scan.mjs. Run: node --test tooling/scripts/s2s-scan.test.mjs (also via gate-tools.test.mjs; CI runs it through tooling-tests.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, countSource, scanTree } from '../ci/s2s-scan.mjs';

test('counts hand-signing and ctx.service on code lines only', () => {
  const text = [
    "import { serviceAuthHeadersForBody } from '@intafaced/contracts';",
    '// serviceAuthHeaders( is mentioned in a comment',
    ' * ctx.service in a doc block',
    "const h = serviceAuthHeadersForBody('svc-x', secret, body);",
    "if (ctx.service !== 'svc-bank') throw new Error('no');",
    'const sig = signServiceCallWithBody(a, b, c, d);',
  ].join('\n');
  assert.deepEqual(countSource(text), { sign: 2, caller: 1 });
});

test('a new hand-signed call, a new name check and a new file all fail; equal passes', () => {
  const baseline = { 'services/svc-a/src/x.ts': { sign: 1, caller: 1 } };
  assert.deepEqual(compare({ 'services/svc-a/src/x.ts': { sign: 1, caller: 1 } }, baseline), []);
  assert.match(compare({ 'services/svc-a/src/x.ts': { sign: 2, caller: 1 } }, baseline)[0], /above the baseline of 1/);
  assert.match(compare({ 'services/svc-a/src/x.ts': { sign: 1, caller: 2 } }, baseline)[0], /serviceProcedureFor/);
  assert.match(
    compare({ ...baseline, 'services/svc-b/src/y.ts': { sign: 1, caller: 0 } }, baseline)[0],
    /svc-b\/src\/y\.ts.*above the baseline of 0/,
  );
});

test('a count that went down passes without touching the baseline', () => {
  const baseline = { 'services/svc-a/src/x.ts': { sign: 2, caller: 0 } };
  assert.deepEqual(compare({ 'services/svc-a/src/x.ts': { sign: 1, caller: 0 } }, baseline), []);
  assert.deepEqual(compare({}, baseline), []);
});

test('scanTree skips test files, node_modules and dist', () => {
  const root = mkdtempSync(join(tmpdir(), 's2s-scan-'));
  const src = join(root, 'services', 'svc-a', 'src');
  mkdirSync(src, { recursive: true });
  mkdirSync(join(root, 'services', 'svc-a', 'node_modules', 'p'), { recursive: true });
  writeFileSync(join(src, 'real.ts'), "serviceAuthHeaders('svc-a', s);\n");
  writeFileSync(join(src, 'real.test.ts'), "serviceAuthHeaders('svc-a', s);\n");
  writeFileSync(join(root, 'services', 'svc-a', 'node_modules', 'p', 'm.ts'), "serviceAuthHeaders('svc-a', s);\n");
  assert.deepEqual(Object.keys(scanTree(join(root, 'services'), root)), ['services/svc-a/src/real.ts']);
});
