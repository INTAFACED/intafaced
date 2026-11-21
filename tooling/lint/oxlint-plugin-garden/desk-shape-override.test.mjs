// The venue spot desk's shape, held by oxlint's own rules through .oxlintrc.json `overrides` (max-lines at 600,
// react/no-multi-comp): a second component or a file past 600 lines fires; one component under the limit does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countPlanted } from '../count-rule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skip = !existsSync(join(ROOT, 'node_modules', '.bin', 'oxlint')) && 'no node_modules';
const DESK = 'apps/customer/src/screens/trade/desk/VenueSpotDesk.tsx';
const ONE = 'export function VenueSpotDesk() {\n  return <div />;\n}\n';

test('a second component in the desk file fires react/no-multi-comp', skip, () => {
  const planted = `${ONE}function VenueSideForm() {\n  return <form />;\n}\n`;
  assert.equal(countPlanted('react/no-multi-comp', { [DESK]: planted }).total, 1);
  assert.equal(countPlanted('react/no-multi-comp', { [DESK]: ONE }).total, 0);
});

test('a desk file past 600 lines fires max-lines; one at 600 does not; another desk file is not judged', skip, () => {
  assert.equal(countPlanted('eslint/max-lines', { [DESK]: `${ONE}${'\n'.repeat(600)}` }).total, 1);
  assert.equal(countPlanted('eslint/max-lines', { [DESK]: `${ONE}${'\n'.repeat(596)}` }).total, 0);
  assert.equal(
    countPlanted('eslint/max-lines', { 'apps/customer/src/screens/trade/desk/OrderForm.tsx': `${ONE}${'\n'.repeat(900)}` }).total,
    0,
  );
});
