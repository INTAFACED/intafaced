import { expect, it } from 'vitest';
import { publishedCopy, publishedLanguageFor } from './copy';

it('uses written published translations and marks English fallback without inventing unknown or parameterized copy', () => {
  expect(publishedCopy('auth.login.title', 'es')).toBe('Iniciar sesión');
  expect(publishedLanguageFor('auth.login.title', 'es')).toBe('es');
  expect(publishedCopy('common.action.save', 'fr')).toBe('Save');
  expect(publishedLanguageFor('common.action.save', 'fr')).toBe('en');
  expect(publishedCopy('missing.article', 'es')).toBeNull();
  expect(publishedLanguageFor('missing.article', 'es')).toBeNull();
  expect(publishedCopy('auth.twofa.prompt', 'es')).toBeNull();
});
