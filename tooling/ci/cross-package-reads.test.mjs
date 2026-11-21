import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TURBO_FILE, checkTurbo, referencedDirs, writeTurbo } from './cross-package-reads.mjs';

const eq = (a, b, m) => assert.deepEqual(a, b, m);

test('referencedDirs finds reads of other packages by literal path, segments and hops', () => {
  const dirs = new Set(['services/svc-a', 'services/svc-b', 'packages/lib']);
  const t = (text, fileDir = 'services/svc-a/src') => [...referencedDirs(text, fileDir, 'services/svc-a', dirs)].sort();
  eq(t("readFileSync('services/svc-b/src/x.ts')"), ['services/svc-b'], 'literal');
  eq(t("join(root, 'packages', 'lib', 'src')"), ['packages/lib'], 'segments');
  eq(t("readFileSync(new URL('../../svc-b/src/x.ts', import.meta.url))"), ['services/svc-b'], 'hop to sibling');
  eq(t("join(__dirname, '../../../packages/lib/src/x.ts')"), ['packages/lib'], 'hop to group');
  eq(t("readFileSync('services/svc-a/src/x.ts')"), [], 'own package ignored');
  eq(t("import x from '../helpers'"), [], 'plain relative import ignored');
});

// One tree, built up step by step: each planted fault must fail checkTurbo until writeTurbo rewrites turbo.json.
test('turbo inputs: the known-good tree passes and each planted fault fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'turbo-reads-'));
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const pkg = (dir, name, deps = {}, scripts = { typecheck: 'tsc --noEmit', build: 'tsc' }) =>
    put(`${dir}/package.json`, { name, dependencies: deps, scripts });
  try {
    put(TURBO_FILE, {
      globalDependencies: ['tooling/ci/test-typecheck.mjs'],
      tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] }, typecheck: { dependsOn: ['^build'], outputs: [] } },
    });
    pkg(
      'apps/r',
      '@t/r',
      { '@t/lib': '*' },
      { typecheck: 'tsc --noEmit && node ../../tooling/ci/test-typecheck.mjs', build: 'next build' },
    );
    pkg('services/p', '@t/p', { '@t/dep2': '*', '@t/lib': '*' });
    pkg('packages/lib', '@t/lib');
    pkg('packages/dep2', '@t/dep2');
    pkg('services/q', '@t/q', {}, { typecheck: 'node ../p/ensure.mjs && tsc --noEmit', build: 'tsc' });
    put('services/q/tsconfig.json', '{ "exclude": ["src/**/*.test.ts", "dist"] }');
    put('services/q/src/a.test.ts', "import { x } from '../../../packages/lib/src/x';");
    put('apps/r/src/a.test.ts', "import { x } from '../../../services/p/src/x';");
    const tracked = ['apps/r/src/a.test.ts'];
    writeTurbo(root);
    const { problems, entries } = checkTurbo(root, { tracked });
    eq(problems, [], 'known-good tree passes');
    eq(
      entries['@t/r#typecheck'].inputs.slice(0, 3),
      ['$TURBO_DEFAULT$', '$TURBO_ROOT$/packages/dep2/**', '$TURBO_ROOT$/services/p/**'],
      'read + its deps, minus own',
    );
    eq(entries['@t/r#typecheck'].dependsOn, ['^build'], 'generic task copied');
    eq(Boolean(entries['@t/r#build']), true, 'a build that types its tests covers the reads');
    eq(
      Object.keys(entries).filter((k) => k.startsWith('@t/q')),
      ['@t/q#typecheck'],
      'script read covered; excluded tests leave build alone',
    );
    // Planted fault 1: an input dropped from turbo.json.
    const t = JSON.parse(readFileSync(join(root, TURBO_FILE), 'utf8'));
    t.tasks['@t/r#typecheck'].inputs = t.tasks['@t/r#typecheck'].inputs.filter((i) => !i.includes('services/p'));
    writeFileSync(join(root, TURBO_FILE), JSON.stringify(t));
    eq(checkTurbo(root, { tracked }).problems, ['@t/r#typecheck differs from what its reads need'], 'dropped input fails');
    writeTurbo(root);
    // Planted fault 2: a new test read that turbo.json does not carry yet.
    put('packages/lib/src/b.test.ts', "readFileSync('services/p/src/x.ts')");
    eq(checkTurbo(root, { tracked }).problems.length, 2, 'new read fails until --write-turbo');
    writeTurbo(root);
    eq(checkTurbo(root, { tracked }).problems, [], 'rewritten tree passes');
    // Planted fault 4: a test imports a file outside every package, whose types import another (review of 13 Nov 2026).
    put('tooling/s/x.mjs', 'export const x = 1;');
    put('tooling/s/x.d.mts', "export { y as x } from './y.mjs';");
    put('tooling/s/ref.d.ts', '/// <reference path="ref2.d.ts" />');
    put('tooling/s/y.d.mts', 'export declare const y: number;');
    put('services/q/tsconfig.test.json', '{ "include": ["src/**/*"], "exclude": ["dist"] }');
    put(
      'services/q/src/c.test.ts',
      "import { x } from '../../../tooling/s/x.mjs';\nconst u = new URL('../../../tooling/s/run.mjs', import.meta.url);",
    );
    eq(
      checkTurbo(root, { tracked }).problems,
      ['@t/q#typecheck differs from what its reads need'],
      'outside import fails until --write-turbo',
    );
    writeTurbo(root);
    eq(
      checkTurbo(root, { tracked }).entries['@t/q#typecheck'].inputs.filter((i) => i.includes('tooling')),
      ['$TURBO_ROOT$/tooling/s/x.*', '$TURBO_ROOT$/tooling/s/y.*'],
      'outside import and its type import hashed; a runtime URL is not; excluded tests leave build alone',
    );
    eq(Boolean(checkTurbo(root, { tracked }).entries['@t/q#build']), false, 'build skips tests its tsconfig excludes');
    // Planted faults 5 to 7 (review round 2): a JSON import, a triple-slash reference, and an outside file that imports
    // back into a package the reader does not depend on.
    put(
      'services/q/src/d.test.ts',
      '/// <reference path="../../../tooling/s/ref.d.ts" />\nimport data from \'../../../tooling/s/data.json\';',
    );
    put('tooling/s/y.d.mts', "export type { Z } from '../../packages/dep2/src/z.js';\nexport declare const y: number;");
    eq(checkTurbo(root, { tracked }).problems, ['@t/q#typecheck differs from what its reads need'], 'faults 5 to 7 fail');
    writeTurbo(root);
    eq(
      checkTurbo(root, { tracked }).entries['@t/q#typecheck'].inputs.filter((i) => i.includes('tooling') || i.includes('dep2')),
      [
        '$TURBO_ROOT$/packages/dep2/**',
        '$TURBO_ROOT$/tooling/s/data.json',
        '$TURBO_ROOT$/tooling/s/ref.d.*',
        '$TURBO_ROOT$/tooling/s/ref2.d.*',
        '$TURBO_ROOT$/tooling/s/x.*',
        '$TURBO_ROOT$/tooling/s/y.*',
      ],
      'JSON hashed as itself, reference followed (a bare sibling name too), package imported back covered',
    );
    // Planted fault 3: a tracked file under an ignored output dir, and a script path nothing hashes.
    eq(checkTurbo(root, { tracked: ['services/p/dist/x.js'] }).problems.length, 1, 'tracked file left out of the hash fails');
    pkg('services/q', '@t/q', {}, { typecheck: 'node ../../tooling/x.mjs && tsc --noEmit' });
    eq(checkTurbo(root, { tracked }).problems.length, 2, 'unhashed script path fails');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
