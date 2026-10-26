import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MESSAGE_KEYS, en, isPluralMessage } from './catalog.js';
import { BIDI_TRAPS, RTL_SAMPLES, pseudoCatalog, pseudoLocalize } from './fixtures.js';
import { createTranslator } from './t.js';

describe('pseudoLocalize', () => {
  it('accents, lengthens by about 30% and brackets', () => {
    expect(pseudoLocalize('Send money')).toBe('⟦Šéñð ɱóñéý ~·ẅ⟧');
    const out = pseudoLocalize('Available balance', { brackets: false });
    expect([...out].length).toBeGreaterThanOrEqual(Math.ceil('Available balance'.length * 1.3));
  });

  it('keeps placeholders exact so interpolation still works', () => {
    expect(pseudoLocalize('Bought {qty} {symbol}')).toContain('{qty}');
    expect(pseudoLocalize('Bought {qty} {symbol}')).toContain('{symbol}');
  });

  it('takes a different expansion', () => {
    expect(pseudoLocalize('abcd', { expansion: 2, brackets: false })).toBe('áƀçð ~·ẅ~');
  });
});

describe('pseudoCatalog', () => {
  it('covers every English key, plural forms included, and interpolates', () => {
    const catalog = pseudoCatalog();
    expect(Object.keys(catalog).sort()).toEqual([...MESSAGE_KEYS].sort());
    for (const key of MESSAGE_KEYS) {
      const source = en[key];
      const pseudo = catalog[key];
      if (isPluralMessage(source)) expect(Object.keys(pseudo as object).sort()).toEqual(Object.keys(source).sort());
      else expect(pseudo).toMatch(/^⟦[\s\S]*⟧$/);
    }
    const { t } = createTranslator('en', catalog);
    const first = MESSAGE_KEYS.find((key) => typeof en[key] === 'string' && !/\{/.test(en[key] as string));
    expect(first).toBeDefined();
    if (first) expect(t(first as never)).toMatch(/^⟦/);
  });
});

describe('RTL samples', () => {
  it('are in their own script', () => {
    for (const sample of Object.values(RTL_SAMPLES)) {
      const script = sample.lang === 'ar' ? /\p{Script=Arabic}/u : /\p{Script=Hebrew}/u;
      for (const [field, text] of Object.entries(sample)) {
        if (field === 'lang') continue;
        expect(text, `${sample.lang}.${field}`).toMatch(script);
        expect(text, `${sample.lang}.${field}`).not.toMatch(/[A-Za-z]/);
      }
    }
  });

  it('hold traps that are left-to-right by nature', () => {
    for (const value of Object.values(BIDI_TRAPS)) expect(value).not.toMatch(/[\p{Script=Arabic}\p{Script=Hebrew}]/u);
  });

  it('never reach a product source', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.turbo', 'coverage', '.git'].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.(test|spec|pw)\.|playwright|harness|gallery/.test(path)) {
          if (readFileSync(path, 'utf8').includes('@intafaced/i18n/fixtures')) hits.push(path.slice(root.length));
        }
      }
    };
    for (const top of ['apps', 'services']) walk(join(root, top));
    expect(hits).toEqual([]);
  });
});
