// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageMenu } from './LanguageMenu';
import { currentPreferences, savePreferences } from './preferences';
import { defineCopy } from './i18n';

// TEST data: an English-only feature beside a written one, so the share is partial as it is in the real app.
defineCopy('test.language.partial', { a: 'One', b: 'Two', c: 'Three', d: 'Four' }, { es: { a: 'Uno' } });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const chosen: string[] = [];

async function show(keptIn: 'browser' | 'account' | 'not-saved' = 'browser') {
  await act(async () =>
    root.render(
      <LanguageMenu
        keptIn={keptIn}
        onSelect={(language) => {
          chosen.push(language);
          savePreferences({ language });
        }}
      />,
    ),
  );
}
const select = () => host.querySelector<HTMLSelectElement>('select')!;
const pick = (value: string) =>
  act(async () => {
    select().value = value;
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  chosen.length = 0;
  savePreferences({ language: 'en' });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('language menu', () => {
  it('lists the written languages under one group and the unwritten ones under another that says they show English', async () => {
    await show();
    const groups = [...host.querySelectorAll('optgroup')];
    expect(groups).toHaveLength(2);
    expect(groups[0]!.getAttribute('label')).toBe('Written in the app');
    expect(groups[1]!.getAttribute('label')).toBe('Not written, shows English');
    expect(groups[0]!.querySelector('option[value="es"]')).not.toBeNull();
    expect(groups[1]!.querySelector('option[value="de"]')).not.toBeNull();
    expect(groups[1]!.querySelector('option[value="es"]')).toBeNull();
  });

  it('shows each written language with its measured share and a machine-translated tag where the files say so', async () => {
    await show();
    const text = host.querySelector('option[value="es"]')!.textContent ?? '';
    expect(text).toMatch(/^español · (<1|\d+)% written/);
    expect(text).toContain('Machine-translated');
    expect(host.querySelector('option[value="en"]')!.textContent).toBe('English');
    expect(host.querySelector('option[value="de"]')!.textContent).not.toContain('%');
  });

  it('signed out, choosing Spanish stores it in the browser, sends nothing and says so', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    await show('browser');
    expect(host.querySelector('[data-language-kept="browser"]')?.textContent).toBe('Saved in this browser only.');
    await pick('es');
    expect(chosen).toEqual(['es']);
    expect(currentPreferences().language).toBe('es');
    expect(fetched).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('says how much of the chosen language is written, and that the rest shows English', async () => {
    await show();
    await pick('es');
    const note = host.querySelector('[data-language-note]')!.textContent ?? '';
    expect(note).toMatch(/^español: el (<1|\d+)% de la app está escrito en este idioma\. El resto se muestra en inglés\./);
    expect(host.querySelector('[data-language-machine]')?.textContent).toBe('Traducción automática, no revisada por una persona.');
  });

  it('keeps a language with no written copy as the stored choice and says the app shows English', async () => {
    await show();
    await pick('de');
    expect(currentPreferences().language).toBe('de');
    expect(host.querySelector('[data-language-note]')?.textContent).toContain('Deutsch has no written copy');
    expect(host.querySelector('[data-language-note]')?.textContent).toContain('shows English');
    expect(host.querySelector('[data-language-machine]')).toBeNull();
  });

  it('tells the signed-in person when the account could not be written, and says nothing extra when it was', async () => {
    await show('account');
    expect(host.querySelector('[data-language-kept]')).toBeNull();
    await show('not-saved');
    expect(host.querySelector('[data-language-kept="not-saved"]')?.textContent).toContain('Not saved to your account');
  });

  it('gives each option its own language and direction, so Arabic reads right-to-left', async () => {
    await show();
    const arabic = host.querySelector('option[value="ar"]')!;
    expect(arabic.getAttribute('lang')).toBe('ar');
    expect(arabic.getAttribute('dir')).toBe('rtl');
    expect(host.querySelector('option[value="es"]')!.getAttribute('dir')).toBe('ltr');
  });

  it('ignores a value that is not a declared language', async () => {
    await show();
    await act(async () => {
      select().insertAdjacentHTML('beforeend', '<option value="zz-ZZ">zz</option>');
      select().value = 'zz-ZZ';
      select().dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(chosen).toEqual([]);
    expect(currentPreferences().language).toBe('en');
  });
});
