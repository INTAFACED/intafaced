import { describe, expect, it } from 'vitest';
import { countPlanted, countRule } from '../../../../tooling/lint/count-rule.mjs';

/**
 * UI-SPEC 1.1 rule 5 and COMPONENT-PLAN 3.4: money never becomes a float. Floats are
 * allowed only for drawing (sparklines, charts, the light objects in `lit/fx/`) and for
 * the design values in `theme/` (spacing, type and radius sizes). Everything else in the
 * kit that touches an amount must stay on decimal strings and bigint.
 *
 * Held by the lint rule garden/no-number-money, which judges every file under `src/` but
 * those (tooling/lint/oxlint-plugin-garden/money-rules.js): a component in a subfolder
 * (`coins/`, `lit/` and its templates) is checked the moment it is added.
 */
const RULE = 'garden/no-number-money';
const FLOATS = [
  'export const a = (s: string) => parseFloat(s);',
  'export const b = (s: string) => Number(s);',
  'export const c = (n: number) => n.toFixed(2);',
  'export const d = (s: string) => +s;',
  '',
].join('\n');

describe('no float arithmetic on money in the UI kit', () => {
  it('has no parseFloat, Number(), toFixed() or unary +value in any of its files', () => {
    expect(countRule(RULE, ['packages/ui/src']).files).toEqual({});
  }, 60_000);

  it('judges every file in subfolders too, and leaves out only drawing code and design values', () => {
    const judged = [
      'components/amount-input-logic.ts',
      'components/numbers.tsx',
      'primitives.tsx',
      'components/coins/coin.tsx',
      'lit/templates/balance.tsx',
    ];
    const left = ['lit/fx/sphere.ts', 'theme/tokens.ts', 'components/sparkline.tsx'];
    const { files } = countPlanted(RULE, Object.fromEntries([...judged, ...left].map((f) => [`packages/ui/src/${f}`, FLOATS])));
    expect(files).toEqual(Object.fromEntries(judged.map((f) => [`packages/ui/src/${f}`, 4])));
  }, 60_000);
});
