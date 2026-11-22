// Planted fault for #9599: a test that reads another package's files with no turbo.json input (cross-package reads).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('reads svc-bank', () => {
  expect(readFileSync(new URL('../../../svc-bank/package.json', import.meta.url), 'utf8')).toContain('svc-bank');
});
