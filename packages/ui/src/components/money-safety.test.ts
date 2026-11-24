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
 * (`coins/`, `lit/` and its templates) is checked the moment it is added. Run strict: a disable comment
 * for the rule counts as a finding, so a float on money cannot be silenced from inside the kit.
 */
const RULE = 'garden/no-number-money';
/** Planted directives are built, so the lint ratchet does not count this file's own strings as suppressions. */
const OFF = ['oxlint', 'disable'].join('-');
const FLOATS = [
  'export const a = (s: string) => parseFloat(s);',
  'export const b = (s: string) => Number(s);',
  'export const c = (n: number) => n.toFixed(2);',
  'export const d = (s: string) => +s;',
  '',
].join('\n');

describe('no float arithmetic on money in the UI kit', () => {
  it('has no parseFloat, Number(), toFixed() or unary +value in any of its files', () => {
    const { files, checked } = countRule(RULE, ['packages/ui/src'], { strict: true });
    expect(files).toEqual({});
    for (const f of ['components/amount-input-logic.ts', 'components/numbers.tsx', 'primitives.tsx'])
      expect(checked).toContain(`packages/ui/src/${f}`);
    expect(checked.some((f) => f.startsWith('packages/ui/src/components/coins/'))).toBe(true);
  }, 60_000);

  it('counts a silenced float as a finding', () => {
    const file = 'packages/ui/src/components/numbers.tsx';
    const silenced = [
      `// ${OFF}-next-line ${RULE} -- planted: a silenced copy still counts`,
      'export const a = (s: string) => parseFloat(s);',
      `/* ${OFF} */`,
      'export const b = (s: string) => Number(s);',
      '',
    ].join('\n');
    expect(countPlanted(RULE, { [file]: silenced }, { strict: true }).files).toEqual({ [file]: 2 });
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
