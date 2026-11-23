/**
 * Tests for feature-entry.mjs: it rewrites an import that reaches inside another feature to that feature's entry, adds
 * what the entry lacks, leaves by hand what is unsafe, and a second run has nothing to do. Each planted import is one of
 * the kinds main held before the rewrite (a named value, a type, a vi.mock with its `typeof import()`, a value from a
 * server-only entry into browser code). Run: node --test tooling/shape/feature-entry.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { apply, findings, plan, siteOf } from './feature-entry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A scratch checkout: the root lint config, its plugin paths made absolute, the root format config, and these files. */
function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'feature-entry-'));
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
  writeFileSync(join(dir, '.prettierrc.json'), readFileSync(join(ROOT, '.prettierrc.json')));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const A = 'apps/admin/src/lib';
const C = 'apps/customer/src/features';

test('reads the import forms it rewrites, and names the ones it leaves by hand', () => {
  const at = (text, spec) => {
    const start = text.indexOf(`'${spec}'`);
    return siteOf(text, start, start + spec.length + 2);
  };
  assert.deepEqual(at("import { a, type B as C } from '@/lib/x/y';\n", '@/lib/x/y').names, [
    { name: 'a', type: false },
    { name: 'B', type: true },
  ]);
  assert.deepEqual(at("import type {\n  B, // why\n} from '@/lib/x/y';\n", '@/lib/x/y').names, [{ name: 'B', type: true }]);
  const mock = "vi.mock('../s/s', async (o) => ({ ...(await o<typeof import('../s/s')>()) }));\n";
  assert.deepEqual(at("import '@/lib/x/y';\n", '@/lib/x/y'), { hand: 'a side-effect import or another form' });
  const site = siteOf(mock, mock.lastIndexOf("'../s/s'"), mock.lastIndexOf("'../s/s'") + 8);
  assert.deepEqual(site, { names: [], mock: { start: 8, end: 16 } });
  assert.match(at("import X from '@/lib/x/y';\n", '@/lib/x/y').hand, /default or namespace/u);
  assert.match(at("import * as X from '@/lib/x/y';\n", '@/lib/x/y').hand, /default or namespace/u);
  assert.match(at("const m = await import('@/lib/x/y');\n", '@/lib/x/y').hand, /dynamic/u);
});

test("rewrites a scratch copy of main's kinds of site, leaves the unsafe one by hand, and a second run finds none left", async () => {
  const dir = scratch({
    [`${A}/desk/index.ts`]: "import 'server-only';\n\nexport { readDeskRequest } from './approval-packet';\n",
    [`${A}/desk/approval-packet.ts`]:
      'export const REASON_MAX = 500;\nexport interface DeskRequest {\n  kind: string;\n}\nexport function readDeskRequest(): DeskRequest | null {\n  return null;\n}\nexport function describeRequest(): string {\n  return "";\n}\n',
    [`${A}/merchants/chips.ts`]: 'export interface ChipSpec {\n  label: string;\n}\n',
    // A type from a feature with no entry yet; a value and a type to add to the desk's server-only entry, from a test.
    [`${A}/founder-ops/read-model.ts`]: "import type { ChipSpec } from '@/lib/merchants/chips';\n\nexport type X = ChipSpec;\n",
    [`${A}/ledger/account-metadata.test.ts`]:
      "import { describeRequest, readDeskRequest, type DeskRequest } from '@/lib/desk/approval-packet';\n\nexport const x: DeskRequest | null = readDeskRequest() ?? (describeRequest() as never);\n",
    // A value from the server-only entry into a file the browser may load: by hand.
    [`${A}/ops-desk/direct-model.ts`]: "import { REASON_MAX } from '@/lib/desk/approval-packet';\n\nexport const max = REASON_MAX;\n",
    [`${C}/session/index.ts`]: "export { useApi } from './session';\n",
    [`${C}/session/session.ts`]: 'export function useApi(): number {\n  return 1;\n}\n',
    [`${C}/more/room.test.tsx`]:
      "import { vi } from 'vitest';\n\nvi.mock('../session/session', async (original) => ({\n  ...(await original<typeof import('../session/session')>()),\n}));\n",
  });
  try {
    const paths = ['apps/admin/src', 'apps/customer/src'];
    const first = findings(dir, paths);
    assert.equal(first.length, 4, JSON.stringify(first));
    const p = plan(first, dir);
    assert.deepEqual(p.hand, [
      'apps/admin/src/lib/ops-desk/direct-model.ts: `@/lib/desk/approval-packet`: a value from the server-only entry of `lib/desk` into a file the browser may load',
    ]);
    await apply(p);
    const read = (f) => readFileSync(join(dir, f), 'utf8');
    assert.match(read(`${A}/founder-ops/read-model.ts`), /from '@\/lib\/merchants';/u);
    assert.match(read(`${A}/merchants/index.ts`), /^export type \{ ChipSpec \} from '\.\/chips';$/mu);
    assert.match(read(`${A}/merchants/index.ts`), /The merchants feature's entry/u);
    assert.match(
      read(`${A}/desk/index.ts`),
      /^export \{ readDeskRequest, describeRequest, type DeskRequest \} from '\.\/approval-packet';$/mu,
    );
    assert.match(read(`${A}/ledger/account-metadata.test.ts`), /from '@\/lib\/desk';/u);
    // The mock and its type move together, so the test still mocks what its subject imports.
    assert.match(read(`${C}/more/room.test.tsx`), /vi\.mock\('\.\.\/session', async[\s\S]*typeof import\('\.\.\/session'\)/u);
    assert.match(read(`${A}/ops-desk/direct-model.ts`), /from '@\/lib\/desk\/approval-packet';/u);
    const second = findings(dir, paths);
    assert.equal(second.length, 1);
    const again = plan(second, dir);
    assert.equal(again.edits.size, 0);
    assert.equal(again.hand.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
