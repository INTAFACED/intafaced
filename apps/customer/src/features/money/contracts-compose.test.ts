import { readFileSync } from 'node:fs';
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
import { bankReads, bankWrites } from './contracts';

// contracts.ts was changed by 15 merged PRs in 7 days (project-state#2618): every bank journey appended its shapes and
// its procedures there. It now only composes the areas, and this test keeps it that way.
const FIX =
  "put the shape in its area file (contracts-<area>.ts) and the procedure in that area's `<area>Reads` or `<area>Writes`; " +
  'contracts.ts only composes the areas';
const ALLOWED = new Set(['bankReads', 'bankWrites', 'BankRead', 'BankWrite', 'bankWriteForReview']);
const source = readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8');
const areas = { accounts, analytics, business, cards, earn, loans, payments, ramps, spaces } as Record<string, Record<string, unknown>>;

describe('contracts.ts only composes the bank areas', () => {
  it('declares nothing of its own beyond the composed reads and writes and the write review', () => {
    const declared = [...source.matchAll(/^(?:export\s+)?(?:const|let|type|interface|function|enum)\s+(\w+)/gm)].map((m) => m[1]!);
    expect(
      declared.filter((name) => !ALLOWED.has(name)),
      FIX,
    ).toEqual([]);
  });

  it('lists no procedure inline: bankReads and bankWrites hold only spreads of the areas', () => {
    for (const name of ['bankReads', 'bankWrites']) {
      const body = source.match(new RegExp(`export const ${name} = \\{\\n([\\s\\S]*?)\\n\\} as const;`))?.[1];
      expect(body, `${name} not found in contracts.ts`).toBeDefined();
      const inline = body!.split('\n').filter((line) => !/^ {2}\.\.\.\w+(?:Reads|Writes),$/.test(line));
      expect(inline, FIX).toEqual([]);
    }
  });

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
