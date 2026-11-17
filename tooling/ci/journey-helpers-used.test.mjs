// journey-helpers-used.mjs: every journey helper, and every name one exports, is used (project-state#2762).
// Run: node --test tooling/ci/journey-helpers-used.test.mjs (also by the tooling-tests gate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findings, trackedCode, exportedNames, HELPER_DIR } from './journey-helpers-used.mjs';

const H = (name) => `${HELPER_DIR}${name}`;

test('this checkout: every journey helper and every export it has is used', () => {
  assert.deepEqual(findings(trackedCode()), []);
});

test('the fault it was written for: a frozen helper named only in path lists, and exports only their own file uses', () => {
  const files = new Map([
    // clauses-v1.mjs: imported by nothing, named only as a bare file name in a CI list.
    [
      H('clauses-v1.mjs'),
      "import { a } from '../../../../tooling/scripts/journey-clauses-v1.mjs';\nexport function clause() { return a; }\n",
    ],
    ['tooling/ci/journey-touch.mjs', "export const STACK_HELPERS = ['clauses-v1.mjs', 'p2p.mjs'];\n"],
    // p2p.mjs: TAKE_STEP_UP is exported and used only inside; acceptAdvertiserTerms is imported.
    [H('p2p.mjs'), "export const TAKE_STEP_UP = 'x';\nexport function acceptAdvertiserTerms() { return TAKE_STEP_UP; }\n"],
    [H('J-p2p-01.pw.mjs'), "import { acceptAdvertiserTerms } from './p2p.mjs';\nacceptAdvertiserTerms();\n"],
    // venue-reads.mjs: VENUE_PERP is used nowhere; a journey's own local of the same name is not a use.
    [H('venue-reads.mjs'), "export const VENUE_SPOT = 'a';\nexport const VENUE_PERP = 'b';\n"],
    [H('J-venue-01.pw.mjs'), "import { VENUE_SPOT } from './venue-reads.mjs';\nconst VENUE_PERP = VENUE_SPOT;\n"],
  ]);
  assert.deepEqual(findings(files), [
    `${H('clauses-v1.mjs')}: no file imports it or names it by path. Delete it, and every list that names it.`,
    `${H('p2p.mjs')}: export TAKE_STEP_UP is imported by no file. Drop \`export\`: only this file uses it.`,
    `${H('venue-reads.mjs')}: export VENUE_PERP is imported by no file. Delete it: nothing uses it.`,
  ]);
});

test('every way a file takes a name counts, and only that name', () => {
  const helper = 'export const A = 1;\nexport const B = 2;\nexport const C = 3;\nexport default function d() {}\n';
  const only = (user, path = 'tooling/scripts/x.test.mjs') =>
    findings(
      new Map([
        [H('h.mjs'), helper],
        [path, user],
      ]),
    ).map((l) => l.match(/export (\S+)/)?.[1] ?? l);
  const rel = '../../apps/customer/tests/real-app/h.mjs';
  // Static: named, renamed, default, and a re-export.
  assert.deepEqual(only("import d, { A, B as b } from './h.mjs';", H('J-1.pw.mjs')), ['C']);
  assert.deepEqual(only("export { A, C } from './h.mjs';", H('k.pw.mjs')), ['B', 'default']);
  // A namespace: the names read off it.
  assert.deepEqual(only(`import * as h from '${rel}';\nh.A; h['B'];`), ['C', 'default']);
  // A dynamic import, destructured or bound, by a literal or a built path, or in a child's code.
  assert.deepEqual(only(`const { A, C: c } = await import('${rel}');`), ['B', 'default']);
  assert.deepEqual(only(`const h = await import('${rel}');\nconst { B } = h; h.C;`), ['A', 'default']);
  assert.deepEqual(only("const h = await import(join(realApp, 'h.mjs'));\nh.A;"), ['B', 'C', 'default']);
  assert.deepEqual(only("const code = `const w = await import(${JSON.stringify(join(realApp, 'h.mjs'))}); w.B;`;"), ['A', 'C', 'default']);
  // Taken whole: a reporter's path string, or an import passed on.
  assert.deepEqual(only("export default { reporter: [['./h.mjs']] };", H('real-app.playwright.config.mjs')), []);
  assert.deepEqual(only(`load(import('${rel}'));`), []);
  // Named but never taken: a bare file name in a list is not a use.
  assert.deepEqual(only("export const LIST = ['h.mjs'];"), [
    `${H('h.mjs')}: no file imports it or names it by path. Delete it, and every list that names it.`,
  ]);
});

test('exportedNames reads declarations, export lists and default, not re-exports', () => {
  const src =
    "export async function a() {}\nexport const b = 1;\nexport class C {}\nconst d = 1;\nexport { d, d as e };\nexport { f } from './f.mjs';\nexport default 1;\n";
  assert.deepEqual([...exportedNames(src)].sort(), ['C', 'a', 'b', 'd', 'default', 'e'].sort());
});
