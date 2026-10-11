import { describe, expect, it } from 'vitest';
import { canonicalUiLocale, uiLocales, uiLocaleDescriptor, uiDirection } from './locale';

describe('published Customer locale seam', () => {
  it('accepts every published descriptor without turning declarations into words', () => {
    expect(uiLocales).toHaveLength(129);
    for (const descriptor of uiLocales) {
      expect(canonicalUiLocale(descriptor.code)).toBe(descriptor.code);
      expect(uiLocaleDescriptor(descriptor.code)).toEqual(descriptor);
    }
  });
  it.each([
    [' FR ', 'fr'],
    ['zh-CN', 'zh-Hans'],
    ['pt', 'pt-BR'],
    ['iw', 'he'],
    ['in', 'id'],
  ])('canonicalizes only published input %s', (input, expected) => {
    expect(canonicalUiLocale(input)).toBe(expected);
  });
  it.each([undefined, null, {}, 123, '', 'zz-ZZ', 'en-US', 'ar<script>', 'ar;q=1', '__proto__', 'constructor'])(
    'refuses malformed or unknown input %s without a default',
    (input) => {
      expect(canonicalUiLocale(input)).toBeUndefined();
    },
  );
  it('uses rendered-language direction independently of a requested RTL descriptor', () => {
    expect(uiLocaleDescriptor('ar').rtl).toBe(true);
    expect(uiDirection('en')).toBe('ltr');
    expect(uiDirection('ar')).toBe('rtl');
  });
});
