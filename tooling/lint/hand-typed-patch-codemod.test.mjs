import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { newErrors, parseTsc } from './hand-typed-patch-codemod.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('a named member takes the class type; a TradeService patch is left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hand-patch-codemod-test-'));
  try {
    const file = join(dir, 'x.ts');
    const source = [
      'class Foo { m(a: number): string { return String(a); } n(): void {} }',
      'class TradeService { placeOrder(a: number): number { return a; } }',
      'export function install(ctor: typeof Foo): void {',
      '  const proto = ctor.prototype as { m: (a: number) => string; n: () => void };',
      '  void proto;',
      '}',
      'export function installTrade(ctor: typeof TradeService): void {',
      '  const proto = ctor.prototype as { placeOrder: (a: number) => number };',
      '  void proto;',
      '}',
      '',
    ].join('\n');
    writeFileSync(file, source);
    // Only the members the rule named are rewritten: `n` is not a target here.
    writeFileSync(
      join(dir, 'targets.json'),
      JSON.stringify({
        [file]: [
          { name: 'm', line: 4 },
          { name: 'placeOrder', line: 8 },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'oxlintrc.json'),
      JSON.stringify({
        plugins: [],
        categories: { correctness: 'off' },
        jsPlugins: [join(ROOT, 'tooling/lint/hand-typed-patch-codemod-plugin.js')],
        rules: { 'hand-patch-codemod/fix': 'error' },
      }),
    );
    const run = spawnSync(join(ROOT, 'node_modules/.bin/oxlint'), ['-c', join(dir, 'oxlintrc.json'), '--fix', file], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, HAND_PATCH_TARGETS: join(dir, 'targets.json') },
    });
    assert.equal(run.error, undefined);
    const after = readFileSync(file, 'utf8').split('\n');
    assert.equal(after[3], "  const proto = ctor.prototype as { m: Foo['m']; n: () => void };");
    assert.equal(after[7], '  const proto = ctor.prototype as { placeOrder: (a: number) => number };');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tsc output is read, and only errors beyond the baseline count as new', () => {
  const before = parseTsc('src/a.ts(3,5): error TS2322: Type A.\nsrc/b.ts(1,1): error TS2352: Cast.\nnoise');
  assert.deepEqual(before[0], { file: 'src/a.ts', line: 3, col: 5, code: 'TS2322', message: 'Type A.' });
  const after = parseTsc('src/a.ts(9,5): error TS2322: Type A.\nsrc/b.ts(1,1): error TS2352: Cast.\nsrc/b.ts(4,1): error TS2352: Cast.');
  assert.deepEqual(
    newErrors(before, after).map((e) => `${e.file}:${e.line}`),
    ['src/b.ts:4'],
  );
});
