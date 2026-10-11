import { describe, expect, it } from 'vitest';
import { defineCopy, renderAuthoredCopy, customerCopyCoverage } from './i18n';

describe('typed customer copy boundary', () => {
  it('counts and tags only enumerable own authored entries, with genuine RTL data as the opposing control', () => {
    const inherited = Object.create({ title: 'Inherited synthetic Arabic fixture' }) as { title?: string };
    Object.defineProperty(inherited, 'reference', { value: 'Hidden synthetic Arabic fixture', enumerable: false });
    const copy = defineCopy('test.own-entry-fallback', { title: 'Title', reference: 'Reference' }, { ar: inherited });
    const arabic = copy.forLocale('ar');
    expect(arabic.t('title')).toBe('Title');
    expect(arabic.t('reference')).toBe('Reference');
    expect(arabic.languageFor('title')).toBe('en');
    expect(arabic.directionFor('title')).toBe('ltr');
    expect(arabic.languageFor('reference')).toBe('en');
    expect(arabic.directionFor('reference')).toBe('ltr');
    expect(arabic.renderedLocale).toBe('en');
    expect(copy.coverage('ar')).toMatchObject({ translated: 0, total: 2, missing: ['title', 'reference'] });
    expect(customerCopyCoverage('ar').find((row) => row.namespace === copy.namespace)).toMatchObject({ translated: 0, total: 2 });
    expect(renderAuthoredCopy(() => arabic.t('title'))).toEqual({ value: 'Title', language: 'en' });

    const own = defineCopy('test.own-entry-rtl', { title: 'Title', reference: 'Reference' }, { ar: { title: 'مثال اصطناعي' } });
    const rendered = own.forLocale('ar');
    expect(rendered.t('title')).toBe('مثال اصطناعي');
    expect(rendered.languageFor('title')).toBe('ar');
    expect(rendered.directionFor('title')).toBe('rtl');
    expect(rendered.languageFor('reference')).toBe('en');
    expect(rendered.directionFor('reference')).toBe('ltr');
    expect(rendered.renderedLocale).toBe('ar');
    expect(own.coverage('ar')).toMatchObject({ translated: 1, total: 2, missing: ['reference'] });
    expect(customerCopyCoverage('ar').find((row) => row.namespace === own.namespace)).toMatchObject({ translated: 1, total: 2 });
  });
  it('accepts a future dictionary as data and keeps per-key fallback/direction honest', () => {
    const copy = defineCopy(
      'test.future-data',
      { title: 'Title', reference: 'Reference {id}' },
      { de: { title: 'Test Deutsch' }, ar: { title: 'Test RTL fixture' } },
    );
    expect(copy.forLocale('de').t('title')).toBe('Test Deutsch');
    expect(copy.forLocale('ar').directionFor('title')).toBe('rtl');
    expect(copy.forLocale('ar').directionFor('reference')).toBe('ltr');
    expect(copy.forLocale('ar').languageFor('reference')).toBe('en');
    expect(copy.forLocale('ur').renderedLocale).toBe('en');
    expect(copy.coverage('ur')).toMatchObject({ translated: 0, total: 2 });
    expect(copy.coverage('de')).toMatchObject({ translated: 1, total: 2 });
  });
  it('refuses invalid future dictionary words, keys and locale identifiers', () => {
    expect(() => defineCopy('test.future-empty', { title: 'Title' }, { de: { title: '' } })).toThrow();
    expect(() => defineCopy('test.future-param', { reference: 'Reference {id}' }, { ar: { reference: 'Test {other}' } })).toThrow(
      /placeholder/,
    );
    expect(() => defineCopy('test.future-unknown', { title: 'Title' }, { xx: { title: 'Unknown' } } as never)).toThrow(/locale/);
    expect(() => defineCopy('test.future-key', { title: 'Title' }, { de: { extra: 'Unknown' } } as never)).toThrow(/key/);
  });
  it('tracks only explicitly authored plain t calls without guessing opaque or mixed prose', () => {
    const copy = defineCopy('test.provenance', { title: 'Title', reference: 'Reference {id}' }, { es: { title: 'Título' } });
    const translated = copy.forLocale('es');
    expect(renderAuthoredCopy(() => translated.t('title'))).toEqual({ value: 'Título', language: 'es' });
    expect(renderAuthoredCopy(() => translated.t('reference', { id: '123456789012345678901234567890' })).language).toBe('en');
    expect(renderAuthoredCopy(() => 'Título')).toEqual({ value: 'Título', language: 'und' });
    expect(renderAuthoredCopy(() => translated.t('title') + translated.t('reference', { id: 'opaque' })).language).toBe('und');
    expect(() =>
      renderAuthoredCopy(() => {
        translated.t('title');
        throw new Error('render failure');
      }),
    ).toThrow();
    expect(renderAuthoredCopy(() => 'Provider prose').language).toBe('und');
  });
  it('refuses a written translation that drops or invents an original reference placeholder', () => {
    expect(() => defineCopy('test.bad-translation', { reference: 'Reference {id}' } as const, { es: { reference: 'Referencia' } })).toThrow(
      /placeholder/i,
    );
    expect(() =>
      defineCopy('test.bad-translation', { reference: 'Reference {id}' } as const, { fr: { reference: 'Référence {amount}' } }),
    ).toThrow(/placeholder/i);
  });
  it('renders authored translations and identifies English fallback without translating domain parameters', () => {
    const copy = defineCopy(
      'test.customer',
      {
        title: 'Confirm',
        reference: 'Original reference: {id}',
        quantity: '{amount} {asset}',
      } as const,
      { es: { title: 'Confirmar' }, fr: { title: 'Confirmer' } },
    );
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
