import { describe, expect, it } from 'vitest';
import { countPlanted, countRule } from '../../../../../tooling/lint/count-rule.mjs';
import * as accounts from './contracts-accounts';
import * as analytics from './contracts-analytics';
import * as business from './contracts-business';
import * as cards from './contracts-cards';
import * as earn from './contracts-earn';
import * as loans from './contracts-loans';
import * as payments from './contracts-payments';
import * as ramps from './contracts-ramps';
import * as spaces from './contracts-spaces';
import { bankReads, bankWrites } from './contracts';

// contracts.ts was changed by 15 merged PRs in 7 days: every bank journey appended its shapes and
// its procedures there. It now only composes the areas, and the lint rule garden/compose-only keeps it that way: .oxlintrc.json
// switches it on for this one file, with the names it may declare and the two objects that hold only spreads of the areas.
const CONTRACTS = 'apps/customer/src/features/money/contracts.ts';
const RULE = 'garden/compose-only';
const areas = { accounts, analytics, business, cards, earn, loans, payments, ramps, spaces } as Record<string, Record<string, unknown>>;
const composed = (reads: string) =>
  [
    "import { accountsReads } from './contracts-accounts';",
    "import { paymentsWrites } from './contracts-payments';",
    `export const bankReads = {\n${reads}\n} as const;`,
    'export type BankRead = keyof typeof bankReads;',
    'export const bankWrites = {\n  ...paymentsWrites,\n} as const;',
    'export type BankWrite = keyof typeof bankWrites;',
    'export function bankWriteForReview(p: BankWrite) {\n  return bankWrites[p];\n}',
    '',
  ].join('\n');

describe('contracts.ts only composes the bank areas', () => {
  it('declares nothing of its own beyond the composed reads and writes and the write review', () => {
    expect(countRule(RULE, [CONTRACTS]).files).toEqual({});
    const shape = composed('  ...accountsReads,') + 'export const cardSchema = z.object({});\nexport type Card = { id: string };\n';
    expect(countPlanted(RULE, { [CONTRACTS]: shape }).total).toBe(2);
  }, 60_000);

  it('lists no procedure inline: bankReads and bankWrites hold only spreads of the areas', () => {
    expect(countPlanted(RULE, { [CONTRACTS]: composed('  ...accountsReads,') }).total).toBe(0);
    expect(countPlanted(RULE, { [CONTRACTS]: composed("  ...accountsReads,\n  'cards.list': cardsSchema,") }).total).toBe(1);
    expect(countPlanted(RULE, { [CONTRACTS]: composed('  ...cardsReads,') }).total).toBe(1);
  }, 60_000);

  it('gives each procedure to one area, so no spread overwrites another', () => {
    for (const [kind, composed] of [
      ['Reads', bankReads],
      ['Writes', bankWrites],
    ] as const) {
      const owners = new Map<string, string[]>();
      for (const [area, mod] of Object.entries(areas)) {
        for (const key of Object.keys((mod[`${area}${kind}`] as object | undefined) ?? {})) {
          owners.set(key, [...(owners.get(key) ?? []), area]);
        }
      }
      expect([...owners].filter(([, by]) => by.length > 1)).toEqual([]);
      expect(Object.keys(composed).sort()).toEqual([...owners.keys()].sort());
    }
  });
});
