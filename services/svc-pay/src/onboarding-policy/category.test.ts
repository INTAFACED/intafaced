import { describe, expect, it } from 'vitest';
import { assertCategoryAllows, categoryRails } from './category.js';

const rule = (cls: 'permissionless' | 'restricted' | 'prohibited', reserveSet = true) => ({ key: `test-${cls}`, class: cls, reserveSet });
const code = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'thrown';
  }
};

describe('the rails a business category allows (RC-merchant-08)', () => {
  it('permissionless takes crypto-native only', () => {
    expect(categoryRails(rule('permissionless'))).toEqual(['crypto-native']);
    expect(code(() => assertCategoryAllows(rule('permissionless'), 'crypto-native'))).toBeNull();
    expect(code(() => assertCategoryAllows(rule('permissionless'), 'bank-transfer-sandbox'))).toBe('pay.category_rail_refused');
    expect(code(() => assertCategoryAllows(rule('permissionless'), 'card-sandbox'))).toBe('pay.category_rail_refused');
  });

  it('restricted drops card rails only: crypto-native and bank transfer still work', () => {
    expect(categoryRails(rule('restricted'))).toEqual(['crypto-native', 'bank-transfer-sandbox']);
    expect(code(() => assertCategoryAllows(rule('restricted'), 'crypto-native'))).toBeNull();
    expect(code(() => assertCategoryAllows(rule('restricted'), 'bank-transfer-sandbox'))).toBeNull();
    expect(code(() => assertCategoryAllows(rule('restricted'), 'card-sandbox'))).toBe('pay.category_rail_refused');
    // A rail nobody named for the class is refused, never let through because it is not called a card.
    expect(code(() => assertCategoryAllows(rule('restricted'), 'some-later-rail'))).toBe('pay.category_rail_refused');
    expect(code(() => assertCategoryAllows(rule('restricted'), null))).toBe('pay.category_rail_refused');
    expect(code(() => assertCategoryAllows(rule('restricted', false), 'bank-transfer-sandbox'))).toBe('pay.reserve_terms_unset');
  });

  it('prohibited takes nothing, and no category limits nothing', () => {
    expect(categoryRails(rule('prohibited'))).toBeNull();
    expect(code(() => assertCategoryAllows(rule('prohibited'), 'crypto-native'))).toBe('pay.category_prohibited');
    expect(categoryRails(null)).toBeNull();
    expect(code(() => assertCategoryAllows(null, 'card-sandbox'))).toBeNull();
  });
});
