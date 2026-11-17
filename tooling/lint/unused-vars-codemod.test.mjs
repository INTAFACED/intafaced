import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kindOf, main } from './unused-vars-codemod.mjs';

test('the four kinds it fixes are read from the rule messages; the rest are left', () => {
  assert.deepEqual(kindOf("Identifier 'b' is imported but never used."), { kind: 'import', name: 'b' });
  assert.deepEqual(kindOf("Type 'T' is imported but never used."), { kind: 'import', name: 'T' });
  assert.deepEqual(kindOf("Catch parameter 'e' is caught but never used."), { kind: 'catch', name: 'e' });
  assert.deepEqual(kindOf("Function 'f' is declared but never used."), { kind: 'function', name: 'f' });
  assert.deepEqual(kindOf("Type alias 'A' is declared but never used."), { kind: 'type', name: 'A' });
  assert.equal(kindOf("Variable 'v' is declared but never used. Unused variables should start with a '_'."), null);
  assert.equal(kindOf("Parameter 'p' is declared but never used. Unused parameters should start with a '_'."), null);
});

test('removes only what cannot change behaviour, until nothing is left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unused-codemod-test-'));
  try {
    const file = join(dir, 'x.ts');
    writeFileSync(
      file,
      [
        '// é header — stays',
        "import { randomUUID } from 'node:crypto';",
        "import { a, b } from './m';",
        "import type { T } from './t';",
        "import { type U } from './u';",
        "import { c, d as e } from './c';",
        "import side from './side';",
        "import { EventEmitter } from 'events';",
        'export function f(): number {',
        '  try {',
        '    return a + c;',
        '  } catch (err) {',
        '    return 0;',
        '  }',
        '}',
        'function unused() {',
        '  return helper();',
        '}',
        'function helper() {',
        '  return 1;',
        '}',
        'type Alias = string;',
        'const v = sideEffect();',
        '',
      ].join('\n'),
    );
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(main([dir, '--write']), 0);
    } finally {
      console.log = log;
    }
    // Prettier finds no repo config in a temp folder, so it writes double quotes there.
    const after = readFileSync(file, 'utf8').replaceAll('"', "'");
    assert.equal(
      after,
      [
        '// é header — stays',
        "import { a } from './m';",
        "import { type U } from './u';", // still loads './u' under verbatimModuleSyntax: kept
        "import { c } from './c';",
        "import side from './side';", // a whole value import: its top-level code would be skipped
        "import { EventEmitter } from 'events';", // a bare name may be a browser polyfill
        'export function f(): number {',
        '  try {',
        '    return a + c;',
        '  } catch {',
        '    return 0;',
        '  }',
        '}',
        'const v = sideEffect();', // its initialiser may have effects
        '',
      ].join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
