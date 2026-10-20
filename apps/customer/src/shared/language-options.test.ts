import { describe, expect, it } from 'vitest';
import { localeCoverage } from '@intafaced/i18n';
import { languageOptions, writtenShare } from './language-options';
import { uiLocales } from './locale';
import { defineCopy } from './i18n';

// TEST data: an English-only feature beside a written one, so the share is partial as it is in the real app.
defineCopy('test.language.partial', { a: 'One', b: 'Two', c: 'Three', d: 'Four' }, { es: { a: 'Uno' } });

describe('language options (RC-home-ia-05)', () => {
  it('lists every declared language once, split by whether the app has words in it', () => {
    const { written, unwritten } = languageOptions();
    expect(written.length + unwritten.length).toBe(uiLocales.length);
    expect(new Set([...written, ...unwritten].map((option) => option.code)).size).toBe(uiLocales.length);
    expect(written[0]?.code).toBe('en');
    expect(written.map((option) => option.code)).toEqual(expect.arrayContaining(['es']));
    expect(unwritten.every((option) => option.share === '0' && !option.written)).toBe(true);
    expect(unwritten.map((option) => option.code)).toContain('de');
  });

  it('measures the written share from the registered copy, never rounds it up, and says 100 only for English', () => {
    expect(writtenShare('en').label).toBe('100');
    expect(writtenShare('de')).toMatchObject({ translated: 0, label: '0' });
    const es = writtenShare('es');
    expect(es.translated).toBeGreaterThan(0);
    expect(es.translated).toBeLessThan(es.total);
    expect(Number(es.label)).toBeLessThanOrEqual((es.translated * 100) / es.total);
    expect(Number(es.label)).toBeGreaterThan((es.translated * 100) / es.total - 1);
  });

  it('carries the package provenance: machine for a file written by a program, none for English and for a language with no file', () => {
    const { written, unwritten } = languageOptions();
    const byCode = new Map([...written, ...unwritten].map((option) => [option.code, option]));
    const files = new Map(localeCoverage().map((row) => [row.code, row]));
    expect(byCode.get('en')?.provenance).toBeNull();
    expect(byCode.get('de')?.provenance).toBeNull();
    expect(['human', 'machine']).toContain(byCode.get('es')?.provenance);
    expect(files.get('es')?.hasCatalog).toBe(true);
  });

  it('puts the right-to-left languages in the list with their own direction', () => {
    const { written, unwritten } = languageOptions();
    expect([...written, ...unwritten].some((option) => option.code === 'ar')).toBe(true);
  });
});
