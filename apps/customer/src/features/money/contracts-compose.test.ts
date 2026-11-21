import { describe, expect, it } from 'vitest';
import * as accounts from './contracts-accounts';
import * as analytics from './contracts-analytics';
import * as business from './contracts-business';
import * as cards from './contracts-cards';
import * as earn from './contracts-earn';
import * as loans from './contracts-loans';
import * as payments from './contracts-payments';
import * as ramps from './contracts-ramps';
import * as spaces from './contracts-spaces';
import { countPlanted, countRule } from '../../../../../tooling/lint/count-rule.mjs';
import { bankReads, bankWrites } from './contracts';

// contracts.ts was changed by 15 merged PRs in 7 days (project-state#2618): every bank journey appended its shapes and
// its procedures there. It now only composes the areas. The lint rule garden/compose-only holds that, switched on for this
// file in .oxlintrc.json with the names it may declare; this test runs the rule strict, so a disable comment for it counts
// as a finding and the rule cannot be silenced from inside the file.
const RULE = 'garden/compose-only';
const OFF = ['oxlint', 'disable'].join('-');
const FILE = 'apps/customer/src/features/money/contracts.ts';
const areas = { accounts, analytics, business, cards, earn, loans, payments, ramps, spaces } as Record<string, Record<string, unknown>>;

describe('contracts.ts only composes the bank areas', () => {
  it('declares nothing of its own and lists no procedure inline, by the rule run strict', () => {
    const { files, checked } = countRule(RULE, [FILE], { strict: true });
    expect(checked).toEqual([FILE]);
    expect(files).toEqual({});
  }, 60_000);

  it('the rule fails a shape, an inline procedure or a silenced declaration added to contracts.ts', () => {
    const planted = [
      "import { accountsReads } from './contracts-accounts';",
      'export type BankRead = string;',
      'export const bankReads = { ...accountsReads, inline: 1 } as const;',
      'export const bankWrites = { ...accountsReads } as const;',
      'export interface NewShape { id: string }',
      `// ${OFF}-next-line ${RULE} -- planted: a silenced copy still counts`,
      'export const silenced = 1;',
      '',
    ].join('\n');
    // The inline procedure, NewShape, and the disable comment, which counts in place of the finding it silences.
    expect(countPlanted(RULE, { [FILE]: planted }, { strict: true }).files).toEqual({ [FILE]: 3 });
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
