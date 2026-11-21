import { describe, expect, it } from 'vitest';
import { countPlanted, countRule } from '../../../../../../tooling/lint/count-rule.mjs';
import { replaceKey } from './replace-key';

const ORDER = '11111111-1111-4111-8111-111111111111';
/** Planted directives are built, so the lint ratchet does not count this file's own strings as suppressions. */
const OFF = ['oxlint', 'disable'].join('-');

describe('the order number of a replacement', () => {
  it('is the same for the same replacement of the same order', () => {
    expect(replaceKey(ORDER, '97', '0.5')).toBe(replaceKey(ORDER, '97', '0.5'));
  });

  it('changes when the new price or amount changes', () => {
    const base = replaceKey(ORDER, '97', '0.5');
    expect(replaceKey(ORDER, '96', '0.5')).not.toBe(base);
    expect(replaceKey(ORDER, '97', '0.4')).not.toBe(base);
  });

  it('changes with the order, so replacing a replacement is a new intent', () => {
    expect(replaceKey('22222222-2222-4222-8222-222222222222', '97', '0.5')).not.toBe(replaceKey(ORDER, '97', '0.5'));
  });

  it('fits the 56 characters a replacement may carry, with a real 36-character order id', () => {
    expect(ORDER).toHaveLength(36);
    expect(replaceKey(ORDER, '123456789012.123456789012345678', '1').length).toBeLessThanOrEqual(56);
  });

  // Held by garden/no-random-request-key, which .oxlintrc.json sets to { anyRandomUUID: true } for both files: any
  // randomUUID there is a finding, in a callback or a field of any name, and strict counts a disable comment for it too.
  it('the desk no longer mints a random number for a place or a replace', () => {
    const place = 'apps/customer/src/screens/trade/desk/OrderForm.tsx';
    const replace = 'apps/customer/src/screens/trade/desk/EditOrder.tsx';
    const real = countRule('garden/no-random-request-key', [place, replace], { strict: true });
    expect(real.checked).toEqual([replace, place]);
    expect(real.files).toEqual({});
    const planted = countPlanted(
      'garden/no-random-request-key',
      {
        [place]: [
          'export const draft = (m: string) => ({ symbol: m, clientOrderId: crypto.randomUUID() });',
          'export const send = (f: (id: () => string) => void) => f(() => crypto.randomUUID());',
          "import { randomUUID } from 'node:crypto';",
          'export const cloid = { cloid: randomUUID() };',
          '',
        ].join('\n'),
        [replace]: [
          `// ${OFF}-next-line garden/no-random-request-key -- planted: a silenced copy still counts`,
          'export const draft = (o: { id: string }) => ({ clientOrderId: `edit:${o.id}:${crypto.randomUUID()}` });',
          '',
        ].join('\n'),
      },
      { strict: true },
    );
    expect(planted.files).toEqual({ [place]: 5, [replace]: 1 });
  }, 60_000);
});
