import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replaceKey } from './replace-key';

const ORDER = '11111111-1111-4111-8111-111111111111';

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

  it('the desk no longer mints a random number for a place or a replace', () => {
    for (const file of ['OrderForm.tsx', 'EditOrder.tsx']) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toMatch(/randomUUID/);
    }
  });
});
