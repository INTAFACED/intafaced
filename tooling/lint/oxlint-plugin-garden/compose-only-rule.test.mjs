// garden/compose-only on planted copies of the bank's contracts.ts (the file .oxlintrc.json switches it on for): a shape,
// a procedure or a helper declared there fires and names the area file; a spread of something not imported, an inline
// procedure and a lost composed object fire; the file as it is composed today does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countPlanted } from '../count-rule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skip = !existsSync(join(ROOT, 'node_modules', '.bin', 'oxlint')) && 'no node_modules';
const RULE = 'garden/compose-only';
const FILE = 'apps/customer/src/features/money/contracts.ts';

const composed = (...extra) =>
  [
    "import { accountsReads } from './contracts-accounts';",
    "import { paymentsReads, paymentsWrites } from './contracts-payments';",
    "export * from './contracts-accounts';",
    'export const bankReads = {\n  ...accountsReads,\n  ...paymentsReads,\n} as const;',
    'export type BankRead = keyof typeof bankReads;',
    'export const bankWrites = {\n  ...paymentsWrites,\n} as const;',
    'export type BankWrite = keyof typeof bankWrites;',
    'export function bankWriteForReview(p: BankWrite) {\n  return bankWrites[p];\n}',
    ...extra,
    '',
  ].join('\n');

test('the file as composed today has no finding, and the rule is on only for contracts.ts', skip, () => {
  assert.equal(countPlanted(RULE, { [FILE]: composed() }).total, 0);
  assert.equal(
    countPlanted(RULE, { 'apps/customer/src/features/money/contracts-cards.ts': composed('export const cardSchema = 1;') }).total,
    0,
  );
});

test('a shape, a type, a helper or a const of its own fires, each once', skip, () => {
  const { total } = countPlanted(RULE, {
    [FILE]: composed(
      'export const cardSchema = z.object({});',
      'export type Card = { id: string };',
      'interface Row { id: string }',
      'function helper() {}',
      'const local = 1;',
    ),
  });
  assert.equal(total, 5);
});

test('an inline procedure, a spread of something not imported, a composed object that is not an object, or a lost one fires', skip, () => {
  const inline = composed().replace('  ...paymentsReads,', "  ...paymentsReads,\n  'cards.list': cardsSchema,");
  assert.equal(countPlanted(RULE, { [FILE]: inline }).total, 1);
  const notImported = composed().replace('  ...paymentsReads,', '  ...cardsReads,');
  assert.equal(countPlanted(RULE, { [FILE]: notImported }).total, 1);
  const notObject = composed().replace(/export const bankWrites = \{[^}]*\} as const;/u, 'export const bankWrites = makeWrites();');
  assert.equal(countPlanted(RULE, { [FILE]: notObject }).total, 1);
  const lost = composed().replace(/export const bankWrites = \{[^}]*\} as const;/u, '');
  assert.ok(countPlanted(RULE, { [FILE]: lost }).total >= 1);
});
