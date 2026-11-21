// The money rules' wider scopes on planted files: garden/no-number-money judges every float conversion in the UI kit (but
// its drawing code, design values and gallery) and Number(), parseFloat() and parseInt() in the i18n formatter;
// garden/no-random-request-key judges a client order id. The rules' older cases are in index.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countPlanted } from '../count-rule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skip = !existsSync(join(ROOT, 'node_modules', '.bin', 'oxlint')) && 'no node_modules';
const UI = 'packages/ui/src/';
const FLOATS =
  'export const a = (s: string) => parseFloat(s);\nexport const b = (s: string) => Number(s);\nexport const c = (n: number) => n.toFixed(2);\nexport const d = (s: string) => +s;\n';

test('no-number-money: every float conversion in the UI kit fires, in subfolders too', skip, () => {
  const { files } = countPlanted('garden/no-number-money', {
    [`${UI}components/amount-input-logic.ts`]: FLOATS,
    [`${UI}components/coins/coin.tsx`]: FLOATS,
    [`${UI}lit/templates/balance.tsx`]: FLOATS,
    [`${UI}primitives.tsx`]: FLOATS,
  });
  for (const file of ['components/amount-input-logic.ts', 'components/coins/coin.tsx', 'lit/templates/balance.tsx', 'primitives.tsx'])
    assert.equal(files[`${UI}${file}`], 4, `${file}: ${JSON.stringify(files)}`);
});

test('no-number-money: the UI kit leaves out only drawing code, design values, the gallery and its tests', skip, () => {
  const { total, files } = countPlanted('garden/no-number-money', {
    [`${UI}lit/fx/sphere.ts`]: FLOATS,
    [`${UI}theme/tokens.ts`]: FLOATS,
    [`${UI}components/sparkline.tsx`]: FLOATS,
    [`${UI}components/chart/axis.ts`]: FLOATS,
    [`${UI}__gallery__/money.tsx`]: FLOATS,
    [`${UI}components/numbers.test.ts`]: FLOATS,
    [`${UI}components/prose.ts`]: "// never parseFloat(x) or Number(x)\nexport const s = 'Number(x) .toFixed(2)';\n",
  });
  assert.equal(total, 0, JSON.stringify(files));
});

test('no-number-money: the i18n formatter has no Number(), parseFloat() or parseInt(), but its toFixed on a ratio stays', skip, () => {
  const { files } = countPlanted('garden/no-number-money', {
    'packages/i18n/src/format.ts':
      'export const a = (s: string) => Number(s);\nexport const b = (s: string) => parseFloat(s);\nexport const c = (s: string) => parseInt(s, 10);\nexport const d = (s: string) => new Number(s);\n',
    'packages/i18n/src/clean/format.ts': 'export const a = (s: string) => Number(s);\n',
  });
  assert.deepEqual(files, { 'packages/i18n/src/format.ts': 4 });
  const quiet = countPlanted('garden/no-number-money', {
    'packages/i18n/src/format.ts':
      'export const r = (ratio: number) => ratio.toFixed(10);\nexport const ok = (n: number) => Number.isNaN(n);\n',
  });
  assert.equal(quiet.total, 0, JSON.stringify(quiet.files));
});

test('no-random-request-key: a random client order id fires; a business key does not', skip, () => {
  const D = 'apps/customer/src/screens/trade/desk/';
  const { files } = countPlanted('garden/no-random-request-key', {
    [`${D}Place.tsx`]: 'export const draft = (m) => ({ symbol: m, clientOrderId: crypto.randomUUID() });\n',
    [`${D}Edit.tsx`]:
      "import { randomUUID } from 'node:crypto';\nexport function send(api) {\n  const clientOrderId = `edit:${randomUUID()}`;\n  return api.mutate({ clientOrderId });\n}\n",
    [`${D}Clean.tsx`]:
      "import { replaceKey } from './replace-key';\nexport const draft = (o, p, a) => ({ clientOrderId: replaceKey(o.id, p, a), other: 'desk-preview' });\n",
  });
  // The const and the body field it fills are both the random key.
  assert.deepEqual(files, { [`${D}Edit.tsx`]: 2, [`${D}Place.tsx`]: 1 });
});

test('no-random-request-key { anyRandomUUID }: in the desk place and replace any randomUUID fires; elsewhere only a key', skip, () => {
  const D = 'apps/customer/src/screens/trade/desk/';
  const callback = 'export const send = (f) => f(() => crypto.randomUUID());\nexport const o = { cloid: crypto.randomUUID() };\n';
  const { files } = countPlanted('garden/no-random-request-key', {
    [`${D}OrderForm.tsx`]: callback,
    [`${D}EditOrder.tsx`]: callback,
    [`${D}Other.tsx`]: callback,
    [`${D}OrderForm.test.tsx`]: callback,
  });
  assert.deepEqual(files, { [`${D}EditOrder.tsx`]: 2, [`${D}OrderForm.tsx`]: 2 });
});
