import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UiSmoke } from './ui-smoke';
import { UiScope } from './ui-scope';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const names = (css: string) => new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]!));

describe('the shared UI kit renders inside the console', () => {
  const html = renderToStaticMarkup(<UiSmoke />);

  it('wraps everything in the .ui-scope hook', () => {
    expect(html).toMatch(/^<div data-ui-scope="" class="ui-scope [^"]*"/);
    expect(renderToStaticMarkup(<UiScope />)).toBe('<div data-ui-scope="" class="ui-scope"></div>');
  });

  it('renders a button, status tags, tabs, and the closed triggers of a menu, dialog, select and tooltip', () => {
    for (const slot of [
      'button',
      'status-tag',
      'tabs',
      'tabs-list',
      'tabs-tab',
      'tabs-panel',
      'menu-trigger',
      'select-trigger',
      'dialog-trigger',
      'tooltip-trigger',
    ]) {
      expect(html, slot).toContain(`data-slot="${slot}"`);
    }
    expect(html).toContain('Waiting on us');
    expect(html).toContain('Investors');
    expect(html).toContain('Both founders');
  });

  it('keeps popup content out of the page until it is opened', () => {
    expect(html).not.toContain('Hand to Phantom');
    expect(html).not.toContain('Decline this enquiry');
    expect(html).not.toContain('Help text sits on a raised surface.');
  });

  it('sets no inline style or script itself (the console CSP allows only nonced scripts)', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it('puts the lime action colour on the primary button through a token class, never a hex', () => {
    expect(html).toContain('bg-lime');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

describe('ui-kit.css keeps the existing console pages untouched', () => {
  const css = read('./ui-kit.css');

  it('never imports Tailwind Preflight', () => {
    expect(css).not.toMatch(/@import\s+['"]tailwindcss['"]/);
    expect(css).not.toMatch(/@import[^;]*preflight/i);
  });

  it('scans only the kit and the crm2 folder, with no automatic source detection', () => {
    expect(css).toMatch(/@import 'tailwindcss\/utilities\.css' layer\(utilities\) source\(none\);/);
    expect([...css.matchAll(/^@source\s+([^;]+);/gm)].map((m) => m[1])).toEqual(["'./'"]);
    expect(read('../../../../../packages/ui/src/theme/theme.css')).toMatch(/^@source '\.\.\/components';/m);
  });

  it('puts every rule in a layer so hand-written CSS always wins', () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/g, '');
    expect(body).toMatch(/^\s*@layer theme, kit-defaults, console-map, base, components, utilities;/);
    const unlayered = body
      .replace(/^\s*@layer [a-z-]+(, [a-z-]+)+;/m, '')
      .replace(/@layer [a-z-]+ \{[\s\S]*?\n\}\n/g, '')
      .replace(/@source[^;]*;/g, '')
      .trim();
    expect(unlayered).toBe('');
  });

  it('maps every colour the kit defines onto the console tokens, or leaves it to the console', () => {
    const kitTokens = read('../../../../../packages/ui/src/theme/tokens.css');
    const mapped = names(css.slice(css.indexOf('@layer console-map')));
    const kitColours = [...kitTokens.matchAll(/^\s*(--if-[a-z0-9-]+):\s*(#|rgba?\()/gm)].map((m) => m[1]!);
    expect(kitColours.length).toBeGreaterThan(40);
    const consoleOwned = names(read('../../app/globals.css') + read('../../../../../packages/ui/src/tokens.css'));
    const unmapped = kitColours.filter((name) => !mapped.has(name) && !consoleOwned.has(name));
    expect(unmapped).toEqual([]);
    // The console's value wins for the two names both sides define: the map must not redefine them.
    for (const shared of ['--if-warn', '--if-font-mono']) expect(mapped.has(shared), shared).toBe(false);
  });

  it('only references custom properties the console defines', () => {
    const map = css.slice(css.indexOf('@layer console-map'), css.indexOf('@layer base'));
    const defined = new Set([
      ...names(read('../../app/globals.css')),
      ...names(read('../../../../../packages/ui/src/tokens.css')),
      ...names(map),
    ]);
    const used = [...map.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!);
    expect(used.filter((name) => !defined.has(name))).toEqual([]);
  });

  it('keeps lime as the console accent', () => {
    expect(css).toMatch(/--if-lime: var\(--if-accent\);/);
    expect(read('../../app/globals.css')).toMatch(/--if-accent: #c8f64a;/i);
  });
});
