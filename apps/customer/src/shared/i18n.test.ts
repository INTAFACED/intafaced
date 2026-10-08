import { describe, expect, it } from 'vitest';
import { defineCopy } from './i18n';

describe('typed customer copy boundary', () => {
  it('renders authored translations and identifies English fallback without translating domain parameters', () => {
    const copy = defineCopy('test.customer', {
      title: 'Confirm',
      reference: 'Original reference: {id}',
      quantity: '{amount} {asset}',
    } as const, { es: { title: 'Confirmar' }, fr: { title: 'Confirmer' } });
    const spanish = copy.forLocale('es');
    expect(spanish.t('title')).toBe('Confirmar');
    expect(spanish.languageFor('title')).toBe('es');
    expect(spanish.t('reference', { id: 'Confirm' })).toBe('Original reference: Confirm');
    expect(spanish.languageFor('reference')).toBe('en');
    expect(spanish.t('quantity', { amount: '0.000000000000000001', asset: 'BTC' })).toBe('0.000000000000000001 BTC');
    expect(copy.forLocale('fr').t('title')).toBe('Confirmer');
    expect(copy.coverage('es')).toMatchObject({ translated: 1, total: 3, missing: ['reference', 'quantity'] });
    if (false) {
      // @ts-expect-error unknown authored UI keys are compile failures
      spanish.t('not-authored');
      // @ts-expect-error required interpolation parameters are explicit
      spanish.t('reference');
      // @ts-expect-error an ID cannot silently replace an exact amount
      spanish.t('quantity', { id: 'opaque' });
    }
  });
});
